import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDevRelay, type DevRelay } from "../../../scripts/dev-relay.ts";
import { formatPairing, parsePairing, registerRemoteCommands } from "../remote.ts";

type Handler = (args: string, ctx: Ctx) => Promise<void>;
interface Ctx { ui: { notify(m: string, l?: string): void; confirm?: (t: string, m: string) => Promise<boolean> }; hasUI?: boolean }

function harness(env: Record<string, string | undefined>, home: string) {
  const handlers = new Map<string, Handler>();
  const lines: string[] = [];
  registerRemoteCommands({ registerCommand: (n, o) => void handlers.set(n, o.handler as Handler) }, { env: env as NodeJS.ProcessEnv, home, out: (s) => lines.push(s) });
  const ctx: Ctx = { ui: { notify: () => {} } };
  return { run: (args: string, c: Ctx = ctx) => handlers.get("cgs-remote")!(args, c), lines };
}

let relay: DevRelay | null = null;
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-rem-")); dirs.push(d); return d; };
afterEach(() => { relay?.stop(); relay = null; for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

test("pairing string round-trips and rejects junk", () => {
  const s = formatPairing("0123456789abcdef", "ABCD2345");
  expect(parsePairing(s)).toEqual({ deviceId: "0123456789abcdef", code: "ABCD2345" });
  for (const bad of ["", "abc", "0123456789abcdef.abcd2345", "xyz.ABCD2345", "0123456789abcdef.ABCD234"]) expect(parsePairing(bad)).toBeNull();
});

test("host and connect: a client reaches the host through the relay and gets a pong", async () => {
  relay = startDevRelay();
  const env = { CGS_RELAY_URL: relay.url };
  const host = harness(env, tmp());
  await host.run("host");
  const pairing = /connect (\S+)/.exec(host.lines.join("\n"))![1]!;

  const client = harness(env, tmp());
  await client.run(`connect ${pairing}`);
  expect(client.lines.join("\n")).toMatch(/pong from [0-9a-f]{16} in \d+ ms/);
  await host.run("stop");
});

test("a wrong or reused pairing code is refused", async () => {
  relay = startDevRelay();
  const env = { CGS_RELAY_URL: relay.url };
  const host = harness(env, tmp());
  await host.run("host");
  const pairing = /connect (\S+)/.exec(host.lines.join("\n"))![1]!;
  const id = pairing.split(".")[0]!;

  const stranger = harness(env, tmp());
  await stranger.run(`connect ${id}.AAAAAAAA`);
  expect(stranger.lines.join("\n")).toContain("refused: unpaired");

  const first = harness(env, tmp());
  await first.run(`connect ${pairing}`);
  const second = harness(env, tmp());
  await second.run(`connect ${pairing}`);
  expect(second.lines.join("\n")).toContain("refused: unpaired");
  await host.run("stop");
});

test("the host's confirm callback can veto a valid code", async () => {
  relay = startDevRelay();
  const env = { CGS_RELAY_URL: relay.url };
  const host = harness(env, tmp());
  const asked: string[] = [];
  await host.run("host", { ui: { notify: () => {}, confirm: async (_t, m) => { asked.push(m); return false; } }, hasUI: true });
  const pairing = /connect (\S+)/.exec(host.lines.join("\n"))![1]!;
  const client = harness(env, tmp());
  await client.run(`connect ${pairing}`);
  expect(client.lines.join("\n")).toContain("refused: unpaired");
  expect(asked).toHaveLength(1);
  await host.run("stop");
});

test("no default public relay: an unset CGS_RELAY_URL is a clear error", async () => {
  const h = harness({}, tmp());
  await h.run("host");
  expect(h.lines.join("\n")).toContain("CGS_RELAY_URL is not set");
});

test("the relay only ever carries ciphertext", async () => {
  const frames: string[] = [];
  const realSend = WebSocket.prototype.send;
  relay = startDevRelay();
  const env = { CGS_RELAY_URL: relay.url };
  const secret = "PING-ID-PLAINTEXT-MARKER";
  WebSocket.prototype.send = function (d: string) { frames.push(String(d)); return realSend.call(this, d); } as typeof realSend;
  try {
    const host = harness(env, tmp());
    await host.run("host");
    const pairing = /connect (\S+)/.exec(host.lines.join("\n"))![1]!;
    const client = harness(env, tmp());
    await client.run(`connect ${pairing}`);
    await host.run("stop");
  } finally { WebSocket.prototype.send = realSend; }
  expect(frames.length).toBeGreaterThan(3);
  const all = frames.join("\n");
  expect(all).not.toContain('"t":"ping"');
  expect(all).not.toContain("pong");
  expect(all).not.toContain(secret);
});

test("two separate processes: host and client, real relay, real sockets", async () => {
  relay = startDevRelay();
  const homeA = tmp(), homeB = tmp();
  const pluginDir = path.resolve(import.meta.dir, "..");
  const script = (home: string, cmd: string) => `
    import { registerRemoteCommands } from "./remote.ts";
    let h; registerRemoteCommands({ registerCommand: (_n, o) => { h = o.handler; } }, { home: ${JSON.stringify(home)}, env: { CGS_RELAY_URL: ${JSON.stringify(relay.url)} }, out: (s) => console.log(s) });
    await h(${JSON.stringify(cmd)}, { ui: { notify() {} } });
    ${cmd === "host" ? "await new Promise((r) => setTimeout(r, 15000));" : "process.exit(0);"}`;
  const run = (name: string, src: string) => { const f = path.join(pluginDir, name); fs.writeFileSync(f, src); return f; };
  const hostFile = run("_t_host.ts", script(homeA, "host"));
  const hostProc = Bun.spawn([process.execPath, hostFile], { cwd: pluginDir, stdout: "pipe", stderr: "pipe" });
  let clientFile = "";
  try {
    const reader = hostProc.stdout.getReader();
    let text = "";
    while (!/connect (\S+)/.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    const pairing = /connect (\S+)/.exec(text)?.[1];
    if (!pairing) throw new Error(`host did not print a pairing code; stdout: ${text}`);
    clientFile = run("_t_client.ts", script(homeB, `connect ${pairing}`));
    const clientProc = Bun.spawn([process.execPath, clientFile], { cwd: pluginDir, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(clientProc.stdout).text(), new Response(clientProc.stderr).text()]);
    expect(err).toBe("");
    expect(out).toMatch(/pong from [0-9a-f]{16} in \d+ ms/);
  } finally {
    hostProc.kill();
    fs.rmSync(hostFile, { force: true });
    if (clientFile) fs.rmSync(clientFile, { force: true });
  }
}, 20_000);
