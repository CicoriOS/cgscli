import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proxyFor } from "@cgscli/connect";
import { LIVE_BUSY_LINE, LIVE_READY_LINE, REMOTE_ATTACHED_LINE, REMOTE_DETACHED_LINE, RPC_INPUT_PREFIX, TAKEN_OVER_LINE } from "../../packages/connect/src/remote/daemon/live.ts";
import { readAccount, type Account } from "./account.ts";

// `/connect`: this device's remote access (ADR 0036). The relay link, the password check and the sessions live in the
// `cgsconnect` unit of omp's own daemon (patch P12), so remote works exactly while an omp process holds its lease.
// This file is the omp side: it opens the unit, tells it the account and how to launch a session, and turns
// `/connect` subcommands into calls on it. The password is only ever typed into a masked input and goes to the unit,
// which keeps a verifier of it; it never appears in a command line, in history or on a wire.

export const UNIT_KEY = "device";
export const MIN_PASSWORD = 8;

interface UiContext {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  input?(title: string, placeholder?: string, options?: { secret?: boolean }): Promise<string | undefined>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  confirm?(title: string, message: string): Promise<boolean>;
}
interface CommandContext { ui: UiContext }
export interface ConnectExtensionApi {
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: CommandContext): Promise<void> }): void;
  on(event: "tui_attach", handler: (event: TuiAttachEvent) => void): void;
  on(event: "session_shutdown", handler: () => void): void;
  on(event: "session_switch" | "agent_start" | "agent_end", handler: () => void): void;
}

/** What the unit says about itself (see RemoteUnit.status). */
export interface UnitStatus {
  enabled: boolean;
  hasPassword: boolean;
  online: boolean;
  refused: number | null;
  sessions: { authenticated: number };
  lock: { failures: number; until: number };
  browsers: { id: string; name: string; addedAt: number }[];
  fingerprint: { emoji: string[] };
}

export interface TunnelPort {
  send(data: string): boolean;
  start(onData: (chunk: Uint8Array) => void, onClose: (reason: string | null) => void): void;
  close(): void;
}

/** The TUI's attach handle (ADR 0027): `send` takes one encoded RPC line; `receive` takes a parsed frame. */
export interface TuiAttachHandle {
  receive(frame: unknown): void;
  close(): void;
}

export interface LiveSession {
  cwd: string;
  sessionPath?: string;
  title?: string;
  ring?: "idle" | "work" | "think";
  level?: string;
  unseen?: boolean;
}

export interface TuiAttachEvent {
  /** Read at every hello. The session file is absent until the first prompt of an unloaded or new session. */
  session(): LiveSession;
  attach(send: (line: string) => void): TuiAttachHandle;
}

export interface UnitPort {
  call<T>(method: string, params?: unknown): Promise<T>;
  attach(channel: string): Promise<TunnelPort>;
}

/** One live registration: the daemon tunnel stays up while remote access is on. `handle` is held only while a browser is attached. */
interface Registration {
  tunnel: TunnelPort;
  send(line: string): void;
  handle?: TuiAttachHandle;
}

export interface ConnectOptions {
  agentDir: string;
  /** Opens (and keeps leased) the daemon unit. Default: the omp daemon. */
  openUnit?: (file: string) => Promise<UnitPort>;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  deviceName?: string;
  now?: () => number;
  readAccount?: (agentDir: string) => Account | null;
  /** The API origin that currently answers: the account's logical origin may be unreachable from here (ADR 0029). Default: the account's own. */
  origin?: () => Promise<string>;
}

export const remoteStateFile = (agentDir: string) => path.join(agentDir, "cgs", "remote.json");

/** Flags that make a session load the same extension and overlay as this process. */
export function inheritedArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    const a = argv[i]!;
    if (a === "-e" || a === "--extension" || a === "--config") out.push(a, argv[++i]!);
  }
  return out;
}

/**
 * The command that starts this same cgs. A compiled binary is started by its executable alone; an install run by bun
 * (`@cicori/cgs` from npm) needs the runtime plus the entry script, and `bun --mode rpc-ui` alone is not cgs.
 */
export function selfCommand(execPath: string = process.execPath, main: string = Bun.main): string[] {
  return /\$bunfs|~BUN/.test(main) ? [execPath] : [execPath, main];
}

const here = () => fileURLToPath(new URL("../../packages/connect/src/remote/daemon/module.ts", import.meta.url));

/** The part of omp's daemon client this file uses. */
interface DaemonClientLike {
  open(request: { kind: string; scope: { kind: "global" }; key: string; label: string; lease: boolean; params: unknown }): Promise<{ unit: { id: string } }>;
  call<T>(module: string, method: string, params: unknown, options: { unit: string }): Promise<T>;
  attach(unit: string, channel: string): Promise<TunnelPort>;
}

/**
 * The omp daemon's unit, over its client (exported by omp's package root: patch P12). Imported lazily so a stock omp,
 * which lacks the export, loses remote access instead of the extension.
 */
async function openDaemonUnit(file: string): Promise<UnitPort> {
  const host = (await import("@oh-my-pi/pi-coding-agent")) as { daemonClient?: () => Promise<DaemonClientLike> };
  if (!host.daemonClient) throw new Error("This omp build has no cgsconnect daemon module.");
  const client = await host.daemonClient();
  const opened = await client.open({ kind: "cgsconnect", scope: { kind: "global" }, key: UNIT_KEY, label: "CGS remote access", lease: true, params: { impl: here(), stateFile: file } });
  return {
    call: <T>(method: string, params?: unknown) => client.call<T>("cgsconnect", method, params, { unit: opened.unit.id }),
    attach: (channel: string) => client.attach(opened.unit.id, channel),
  };
}

const MESSAGES: Record<string, string> = {
  remote_not_allowed: "This account is not allowed to use remote access. Ask your administrator to enable it.",
  password_required: "Set a password first: run /connect.",
  remote_api_unreachable: "The CGS server could not be reached.",
};

function describe(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return MESSAGES[raw] ?? raw;
}

function stateOf(s: UnitStatus, now: number): string {
  if (!s.enabled) return "off";
  if (s.refused !== null) return `refused by the server (code ${s.refused})`;
  const lock = s.lock.until > now ? `; locked for ${Math.ceil((s.lock.until - now) / 1000)} s (/connect unlock clears it)` : "";
  return `${s.online ? "online" : "connecting"}${lock}`;
}

export interface Connect {
  /** Brings the unit up when the switch is on and the account is known; call at startup and after a login. */
  resume(): Promise<void>;
  /** The /connect handler. */
  run(args: string, ctx: CommandContext): Promise<void>;
  /** The TUI event (ADR 0027): this terminal stands by as a live session while remote access is on. */
  tuiAttach(event: TuiAttachEvent): void;
  /** The TUI is going away: its live registration ends. */
  stopTui(): void;
  /** The session changed or a run started or ended: re-sends the live hello (ADR 0027). */
  refreshHello(): void;
}

export function createConnect(o: ConnectOptions): Connect {
  const env = o.env ?? process.env;
  const file = remoteStateFile(o.agentDir);
  const now = o.now ?? Date.now;
  const open = o.openUnit ?? openDaemonUnit;
  const account = () => (o.readAccount ?? readAccount)(o.agentDir);
  let unit: Promise<UnitPort> | undefined;
  /** The TUI this process runs (ADR 0027). Set while it exists, whether or not remote access is on. */
  let tui: TuiAttachEvent | undefined;
  /** The live registration with the unit. Exists only while remote access is on; detaching a browser does not end it. */
  let registration: Registration | undefined;
  let registering = false;
  const background = (e: unknown): void => { process.stderr.write(`cgs: remote access: ${describe(e)}\n`); };

  /** Ends a registration. The tunnel closes too unless the unit already closed it; a held TUI handle always closes. */
  function unregister(r: Registration, closeTunnel: boolean): void {
    if (registration === r) registration = undefined;
    r.handle?.close();
    r.handle = undefined;
    if (closeTunnel) r.tunnel.close();
  }

  /** Sends the TUI's current session. Runs at registration and on the session events, so new, switched and unloaded sessions stay accurate. */
  function sendHello(r: Registration): void {
    const s = tui?.session();
    if (!s) return;
    r.send(JSON.stringify({ type: "live_hello", cwd: s.cwd, sessionPath: s.sessionPath, title: s.title, ring: s.ring, level: s.level, unseen: s.unseen, updatedAt: now() }));
  }

  /** Registers the TUI as a live session: one daemon tunnel, no child process. Nothing registers while remote access is off. */
  async function registerTui(port?: UnitPort): Promise<void> {
    const a = account();
    if (!tui || registration || registering || !a || (!port && !switchIsOn())) return;
    registering = true;
    try {
      port ??= await ready(a);
      const tunnel = await port.attach(`live:${crypto.randomUUID()}`);
      if (!tui || registration) {
        tunnel.close();
        return;
      }
      const send = (line: string): void => {
        tunnel.send(line.endsWith("\n") ? line : `${line}\n`);
      };
      const r: Registration = { tunnel, send };
      registration = r;
      const decoder = new TextDecoder();
      let rest = "";
      tunnel.start(
        (chunk) => {
          rest += decoder.decode(chunk, { stream: true });
          for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
            const line = rest.slice(0, i);
            rest = rest.slice(i + 1);
            if (registration !== r) return;
            if (line === REMOTE_ATTACHED_LINE) {
              const event = tui;
              if (!event || r.handle) continue;
              try {
                let opening: string[] | undefined = [];
                r.handle = event.attach((frame) => {
                  if (frame.trimEnd() === TAKEN_OVER_LINE) r.handle = undefined;
                  if (opening) opening.push(frame);
                  else send(frame);
                });
                send(LIVE_READY_LINE);
                for (const frame of opening) send(frame);
                opening = undefined;
              } catch {
                send(LIVE_BUSY_LINE);
              }
            } else if (line === REMOTE_DETACHED_LINE) {
              r.handle?.close();
              r.handle = undefined;
            } else if (r.handle && line.startsWith(RPC_INPUT_PREFIX)) {
              let frame: unknown;
              try {
                frame = JSON.parse(line.slice(RPC_INPUT_PREFIX.length));
              } catch {
                continue;
              }
              r.handle.receive(frame);
            }
          }
        },
        () => unregister(r, false),
      );
      if (registration === r) sendHello(r);
    } finally {
      registering = false;
    }
  }

  // Another running TUI can enable the per-device switch. The state file is atomically replaced;
  // watch its path (not a single inode), and never hold the terminal process open for the watch.
  const onSwitchChange = (): void => {
    if (!tui) return;
    if (switchIsOn()) void registerTui().catch(background);
    else if (registration) unregister(registration, true);
  };

  function tuiAttach(event: TuiAttachEvent): void {
    if (!tui) fs.watchFile(file, { persistent: false }, onSwitchChange);
    tui = event;
    if (registration) sendHello(registration);
    else void registerTui().catch(background);
  }

  /** The session changed or a run started or ended: re-send the live hello. Registration and ownership are unchanged. */
  function refreshHello(): void {
    if (registration) sendHello(registration);
  }

  function stopTui(): void {
    fs.unwatchFile(file, onSwitchChange);
    tui = undefined;
    if (registration) unregister(registration, true);
  }

  /** Turns remote access on at the unit, then registers this terminal as live if it runs one. */
  async function enable(port: UnitPort): Promise<UnitStatus> {
    const status = await port.call<UnitStatus>("enable");
    await registerTui(port).catch(background);
    return status;
  }

  /** Opens the unit once per process and (re)configures it with the current account. */
  async function ready(a: Account): Promise<UnitPort> {
    unit ??= open(file).catch((e) => { unit = undefined; throw e; });
    const port = await unit;
    const baseUrl = o.origin ? await o.origin() : a.baseUrl;
    const proxy = proxyFor(new URL(baseUrl), env);
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
    await port.call("configure", {
      baseUrl,
      clientSecret: a.clientSecret,
      deviceName: (o.deviceName ?? os.hostname() ?? "unknown").slice(0, 64),
      agentDir: o.agentDir,
      command: [...(o.execPath !== undefined ? [o.execPath] : selfCommand()), "--mode", "rpc-ui", ...inheritedArgs(o.argv ?? process.argv)],
      env: childEnv,
      ...(proxy ? { proxy } : {}),
    });
    return port;
  }

  function switchIsOn(): boolean {
    try { return (JSON.parse(fs.readFileSync(file, "utf8")) as { enabled?: unknown }).enabled === true; } catch { return false; }
  }

  async function askPassword(ctx: CommandContext): Promise<string | null> {
    const ui = ctx.ui;
    if (!ui.input) { ui.notify("This screen cannot take a masked password.", "error"); return null; }
    const first = await ui.input("Remote access password (min " + MIN_PASSWORD + " characters)", undefined, { secret: true });
    if (first === undefined) return null;
    if (first.length < MIN_PASSWORD) { ui.notify(`The password needs at least ${MIN_PASSWORD} characters.`, "error"); return null; }
    const again = await ui.input("Type the password again", undefined, { secret: true });
    if (again === undefined) return null;
    if (again !== first) { ui.notify("The two entries differ; nothing was changed.", "error"); return null; }
    return first;
  }

  function report(ctx: CommandContext, s: UnitStatus): void {
    const lines = [`Remote access: ${stateOf(s, now())}`, `Device mark: ${s.fingerprint.emoji.join(" ")}`, `Authorized browsers: ${s.browsers.length}${s.sessions.authenticated > 0 ? `, ${s.sessions.authenticated} connected` : ""}`];
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function devices(ctx: CommandContext, port: UnitPort, s: UnitStatus): Promise<void> {
    if (s.browsers.length === 0) return ctx.ui.notify("No browser is authorized.", "info");
    if (!ctx.ui.select) return ctx.ui.notify(s.browsers.map((b) => `${b.name} (${b.id})`).join("\n"), "info");
    const labels = s.browsers.map((b) => `${b.name} (${b.id.slice(0, 8)}), added ${new Date(b.addedAt).toISOString().slice(0, 10)}`);
    const picked = await ctx.ui.select("Revoke a browser", labels);
    const browser = picked === undefined ? undefined : s.browsers[labels.indexOf(picked)];
    if (!browser) return;
    if (ctx.ui.confirm && !(await ctx.ui.confirm("Revoke this browser?", `${browser.name} will need the password again.`))) return;
    await port.call("revokeBrowser", { id: browser.id });
    ctx.ui.notify(`Revoked ${browser.name}.`, "info");
  }

  async function first(ctx: CommandContext, port: UnitPort, s: UnitStatus): Promise<void> {
    const ent = await port.call<{ allowed: boolean }>("entitlement");
    if (!ent.allowed) return ctx.ui.notify(MESSAGES.remote_not_allowed!, "error");
    if (!s.hasPassword) {
      const password = await askPassword(ctx);
      if (password === null) return;
      await port.call("setPassword", { password });
    }
    report(ctx, await enable(port));
  }

  async function dispatch(ctx: CommandContext, port: UnitPort, sub: string): Promise<void> {
    const s = await port.call<UnitStatus>("status");
    switch (sub) {
      case "":
        if (!s.enabled && !s.hasPassword) return first(ctx, port, s);
        return report(ctx, s);
      case "status": return report(ctx, s);
      case "on":
        if (!s.hasPassword) return first(ctx, port, s);
        return report(ctx, await enable(port));
      case "off": {
        const r = await port.call<UnitStatus & { serverNotified: boolean }>("disable");
        ctx.ui.notify(r.serverNotified ? "Remote access is off. The password and authorized browsers are kept; /connect on resumes." : "Remote access is off here, but the server could not be told; the console may still show this device online until it times out.", r.serverNotified ? "info" : "warning");
        return;
      }
      case "forget":
        if (ctx.ui.confirm && !(await ctx.ui.confirm("Forget remote access?", "This removes the password and every authorized browser, and turns remote access off."))) return;
        await port.call("forget");
        return ctx.ui.notify("Remote access was reset: no password, no authorized browsers.", "info");
      case "password": {
        const password = await askPassword(ctx);
        if (password === null) return;
        await port.call("setPassword", { password });
        return ctx.ui.notify("Password changed; every browser must sign in again.", "info");
      }
      case "devices": return devices(ctx, port, s);
      case "unlock":
        await port.call("unlock");
        return ctx.ui.notify("Password lock cleared.", "info");
      default:
        return ctx.ui.notify("usage: /connect [status | on | off | forget | password | devices | unlock]", "warning");
    }
  }

  return {
    async resume() {
      if (!switchIsOn()) return;
      const a = account();
      if (a) await registerTui(await ready(a));
    },
    async run(args, ctx) {
      const a = account();
      if (!a) return ctx.ui.notify("Not logged in to CGS: use /login first.", "error");
      try {
        await dispatch(ctx, await ready(a), args.trim().toLowerCase());
      } catch (e) {
        ctx.ui.notify(describe(e), "error");
      }
    },
    tuiAttach,
    refreshHello,
    stopTui,
  };
}

export function registerConnectCommand(pi: ConnectExtensionApi, o: ConnectOptions): Connect {
  const connect = createConnect(o);
  pi.registerCommand("connect", {
    description: "remote access to this device from the CGS web console (on | off | forget | password | devices | unlock)",
    handler: (args, ctx) => connect.run(args, ctx),
  });
  pi.on("tui_attach", (event) => connect.tuiAttach(event));
  pi.on("session_shutdown", () => connect.stopTui());
  pi.on("session_switch", () => connect.refreshHello());
  pi.on("agent_start", () => connect.refreshHello());
  pi.on("agent_end", () => connect.refreshHello());
  return connect;
}
