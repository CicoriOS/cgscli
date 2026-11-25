import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectToDevice, createRemoteLink, fingerprint, generateKeyPair, RemoteRejected, type KeyPair } from "@cgscli/connect";
import type { Duplex } from "@cgscli/wire";

// `/cgs-remote host | connect <code> | status | stop`: a minimal cli-to-cli end-to-end channel through a relay, carrying
// a test payload (ping/pong) only. No omp traffic, no accounts, no public relay: the relay URL must be given in
// CGS_RELAY_URL (scripts/dev-relay.ts is the local reference). The pairing code is `<relay-room-device-id>.<code>`.

interface CommandContext {
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void; confirm?(title: string, message: string): Promise<boolean> };
  hasUI?: boolean;
}
interface ExtensionApi {
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: CommandContext): Promise<void> }): void;
}

export interface RemoteDeps {
  env?: NodeJS.ProcessEnv;
  /** Where identity files live (the cgs config dir, never ~/.omp). */
  home?: string;
  now?: () => number;
  /** Test seam: print to the user. */
  out?: (s: string) => void;
}

const PATTERN = "XX" as const;

interface State { link: ReturnType<typeof createRemoteLink>; code: string; relay: string }

/** Pairing string a user types on the other machine: `<deviceId>.<code>`. */
export function formatPairing(deviceId: string, code: string): string { return `${deviceId}.${code}`; }
export function parsePairing(s: string): { deviceId: string; code: string } | null {
  const m = /^([0-9a-f]{16})\.([A-Z2-9]{8})$/.exec(s.trim());
  return m ? { deviceId: m[1]!, code: m[2]! } : null;
}

export function registerRemoteCommands(pi: ExtensionApi, deps: RemoteDeps = {}): void {
  const env = deps.env ?? process.env;
  const home = deps.home ?? (env.CGSCLI_HOME?.trim() || path.join(os.homedir(), ".cgs"));
  const now = deps.now ?? Date.now;
  let host: State | null = null;

  const relayUrl = (): string => {
    const u = env.CGS_RELAY_URL?.trim();
    if (!u) throw new Error("CGS_RELAY_URL is not set. There is no default public relay; start one with `bun scripts/dev-relay.ts` and export its URL.");
    return u;
  };
  const say = (ctx: CommandContext, msg: string, level: "info" | "warning" | "error" = "info") => { deps.out?.(msg); ctx.ui.notify(msg, level); };

  async function hostCmd(ctx: CommandContext) {
    if (host) return say(ctx, `already hosting: ${formatPairing(host.link.deviceId(), host.code)}`);
    const relay = relayUrl();
    const link = createRemoteLink({
      relayUrl: relay, pattern: PATTERN, identityFile: path.join(home, "remote", "identity.json"),
      clientSecret: () => env.CGS_RELAY_TOKEN?.trim() || "dev",
      approve: ctx.hasUI && ctx.ui.confirm ? (fp) => ctx.ui.confirm!("Remote connection", `Allow client ${fp}?`) : undefined,
    });
    link.accept((ch) => answerPings(ch, now));
    await link.start();
    const { code } = await link.pairing();
    host = { link, code, relay };
    say(ctx, `Hosting on ${relay}\nPairing code (5 min, single use): ${formatPairing(link.deviceId(), code)}\nOn the other machine: /cgs-remote connect ${formatPairing(link.deviceId(), code)}`);
  }

  async function connectCmd(arg: string, ctx: CommandContext) {
    const p = parsePairing(arg);
    if (!p) return say(ctx, "usage: /cgs-remote connect <deviceId>.<code>", "error");
    const keys = clientKeys(home);
    const ch = await connectToDevice({ relayUrl: relayUrl(), deviceId: p.deviceId, pattern: PATTERN, keys, pairingCode: p.code });
    const started = now();
    const outcome = new Promise<{ pong: true } | { err: Error | undefined }>((resolve) => {
      ch.onMessage((m) => { if (m.t === "pong") resolve({ pong: true }); });
      ch.onClose((e) => resolve({ err: e }));
    });
    ch.send({ t: "ping", id: String(started) });
    const got = await Promise.race([outcome, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    ch.close();
    if (!got) return say(ctx, "no pong within 5 s", "error");
    if ("err" in got) return say(ctx, got.err instanceof RemoteRejected ? `refused: ${got.err.code}` : "connection closed before a pong", "error");
    say(ctx, `pong from ${p.deviceId} in ${now() - started} ms (end-to-end encrypted, client ${fingerprint(keys.pub)})`);
  }

  pi.registerCommand("cgs-remote", {
    description: "cli-to-cli encrypted link through a relay: host | connect <code> | status | stop",
    handler: async (args, ctx) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/);
      try {
        if (sub === "host") await hostCmd(ctx);
        else if (sub === "connect") await connectCmd(rest.join(" "), ctx);
        else if (sub === "status") say(ctx, host ? `hosting ${formatPairing(host.link.deviceId(), host.code)} on ${host.relay}` : "not hosting");
        else if (sub === "stop") { await host?.link.stop(); host = null; say(ctx, "stopped"); }
        else say(ctx, "usage: /cgs-remote host | connect <deviceId>.<code> | status | stop", "warning");
      } catch (e) {
        say(ctx, e instanceof RemoteRejected ? `refused: ${e.code}` : (e instanceof Error ? e.message : String(e)), "error");
      }
    },
  });
}

/** Test payload only: answers `ping` with `pong`, echoing the id. */
function answerPings(ch: Duplex, _now: () => number): void {
  ch.onMessage((m) => { if (m.t === "ping") ch.send({ t: "pong", id: m.id }); });
}

/** The client's own static key, kept next to the device identity with the same permissions. */
function clientKeys(home: string): KeyPair {
  const file = path.join(home, "remote", "client-key.json");
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { priv: string; pub: string };
    return { priv: Uint8Array.from(Buffer.from(j.priv, "hex")), pub: Uint8Array.from(Buffer.from(j.pub, "hex")) };
  }
  const k = generateKeyPair();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ priv: Buffer.from(k.priv).toString("hex"), pub: Buffer.from(k.pub).toString("hex") }), { mode: 0o600 });
  return k;
}
