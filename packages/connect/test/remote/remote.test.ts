import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex, Msg } from "@cgscli/wire";
import { createRemoteLink, generateKeyPair, Handshake, parseEnvelope, SecureChannel, type KeyPair, type PatternName } from "../../src/remote/index.ts";

// ---- mock relay: authenticates nothing, routes envelopes by sid, records every frame it forwards -------------------
interface Relay { url: string; frames: string[]; deviceConnects: Promise<void>[]; waitDeviceConnect(n: number): Promise<void>; dropDevice(): void; stop(): void }
function startRelay(): Relay {
  const frames: string[] = [];
  let device: Bun.ServerWebSocket<{ kind: string; sid?: string }> | null = null;
  const clients = new Map<string, Bun.ServerWebSocket<{ kind: string; sid?: string }>>();
  let connects = 0;
  const connectWaiters: { n: number; resolve: () => void }[] = [];
  let sidN = 0;
  const srv = Bun.serve<{ kind: string; sid?: string }>({
    port: 0,
    fetch(req, s) {
      const u = new URL(req.url);
      if (u.pathname === "/api/devices") return req.method === "POST" ? Response.json({ success: true }) : Response.json([{ id: "d1", name: "box", online: true }]);
      if (u.pathname === "/api/relay/device") return s.upgrade(req, { data: { kind: "device" } }) ? undefined : new Response("no", { status: 400 });
      if (u.pathname === "/api/relay/client") return s.upgrade(req, { data: { kind: "client", sid: `c${++sidN}` } }) ? undefined : new Response("no", { status: 400 });
      return new Response("nf", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "device") {
          device = ws; connects++;
          connectWaiters.filter((w) => connects >= w.n).forEach((w) => w.resolve());
        } else {
          const sid = ws.data.sid!;
          clients.set(sid, ws);
          ws.send(JSON.stringify({ v: 1, type: "ctl", sid, seq: 0, payload: { op: "open" } }));
          device?.send(JSON.stringify({ v: 1, type: "ctl", sid, seq: 0, payload: { op: "open" } }));
        }
      },
      message(ws, data) {
        const text = String(data);
        frames.push(text);
        const env = parseEnvelope(text);
        if (!env) return;
        if (ws.data.kind === "device") clients.get(env.sid)?.send(text);
        else device?.send(text);
      },
      close(ws) { if (ws.data.kind === "device" && device === ws) device = null; else if (ws.data.sid) clients.delete(ws.data.sid); },
    },
  });
  return {
    url: `ws://127.0.0.1:${srv.port}`, frames, deviceConnects: [],
    waitDeviceConnect(n) { if (connects >= n) return Promise.resolve(); const g = Promise.withResolvers<void>(); connectWaiters.push({ n, resolve: g.resolve }); return g.promise; },
    dropDevice() { device?.close(); },
    stop() { srv.stop(true); },
  };
}

// ---- test client (the browser's role) ------------------------------------------------------------------------------
async function connectClient(relayUrl: string, pattern: PatternName, devicePub: Uint8Array, keys: KeyPair, pair?: string): Promise<{ chan: Duplex | null; rejected: Promise<string> }> {
  const ws = new WebSocket(`${relayUrl}/api/relay/client?device=d1`);
  const inbox: string[] = [];
  let wake: (() => void) | null = null;
  const rejected = Promise.withResolvers<string>();
  let onData: ((ct: Uint8Array) => void) | null = null;
  ws.onmessage = (e) => {
    const env = parseEnvelope(String(e.data));
    if (!env) return;
    if (env.type === "ctl") { if (env.payload.op === "error") rejected.resolve(env.payload.code); if (env.payload.op === "close") rejected.resolve("closed"); inbox.push(`ctl:${env.sid}`); }
    else if (onData) onData(Uint8Array.from(Buffer.from(env.payload, "base64"))); else inbox.push(`data:${env.payload}`);
    wake?.();
  };
  await new Promise<void>((r) => (ws.onopen = () => r()));
  let sid = "";
  while (!sid) { const m = inbox.find((x) => x.startsWith("ctl:")); if (m) sid = m.slice(4); else await new Promise<void>((r) => (wake = r)); }
  let seq = 0;
  const send = (b: Uint8Array) => ws.send(JSON.stringify({ v: 1, type: "data", sid, seq: seq++, payload: Buffer.from(b).toString("base64") }));
  const hs = new Handshake({ pattern, initiator: true, s: keys, rs: pattern === "IK" ? devicePub : undefined });
  const payload = new TextEncoder().encode(JSON.stringify(pair ? { pair } : {}));
  const next = () => new Promise<Uint8Array>((r) => { onData = r; });
  if (pattern === "XX") {
    send(hs.write());
    hs.read(await next());
    send(hs.write(payload));
  } else {
    send(hs.write(payload));
    const msg2 = await Promise.race([next(), rejected.promise.then(() => null)]);
    if (!msg2) return { chan: null, rejected: rejected.promise };
    hs.read(msg2);
  }
  const chan = new SecureChannel(hs.split(), send, () => ws.close());
  onData = (ct) => chan.receive(ct);
  return { chan, rejected: rejected.promise };
}

const nextMsg = (d: Duplex) => new Promise<Msg>((r) => d.onMessage(r));

let relay: Relay;
let link: ReturnType<typeof createRemoteLink> | null = null;
let dir = "";
afterEach(async () => { await link?.stop(); link = null; relay?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

async function setup(pattern: PatternName) {
  relay = startRelay();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-remote-"));
  const identityFile = path.join(dir, "identity.json");
  link = createRemoteLink({ relayUrl: relay.url, pattern, identityFile, clientSecret: () => "k", backoffMs: { initial: 1, max: 5 } });
  const sessions: Duplex[] = [];
  const firstSession = Promise.withResolvers<Duplex>();
  link.accept((d) => { sessions.push(d); firstSession.resolve(d); });
  await link.start();
  const devicePub = Uint8Array.from(Buffer.from(JSON.parse(fs.readFileSync(identityFile, "utf8")).pub, "hex"));
  return { sessions, first: firstSession.promise, devicePub };
}

for (const pattern of ["XX", "IK"] as const) {
  test(`${pattern}: pairing code authorizes a client; messages (incl. >64 KiB) are E2E encrypted`, async () => {
    const { first, devicePub } = await setup(pattern);
    const keys = generateKeyPair();
    const { code } = await link!.pairing();
    const { chan } = await connectClient(relay.url, pattern, devicePub, keys, code);
    const deviceSide = await first;

    const secret = "TOP-SECRET-PROMPT";
    const got = nextMsg(deviceSide);
    chan!.send({ t: "event.send", text: secret });
    expect(await got).toEqual({ t: "event.send", text: secret });

    const big = "x".repeat(200_000);
    const back = nextMsg(chan!);
    deviceSide.send({ t: "tsp.snapshot", doc: big });
    expect(((await back) as { doc: string }).doc.length).toBe(200_000);

    const all = relay.frames.join("\n");
    expect(all).not.toContain(secret);
    expect(all).not.toContain("xxxxxxxxxx");
  });

  test(`${pattern}: unpaired client without a valid code is rejected; a code is single-use; a paired key reconnects without one`, async () => {
    const { devicePub } = await setup(pattern);
    const stranger = await connectClient(relay.url, pattern, devicePub, generateKeyPair());
    expect(await stranger.rejected).toBe("unpaired");

    const keys = generateKeyPair();
    const { code } = await link!.pairing();
    const ok = await connectClient(relay.url, pattern, devicePub, keys, code);
    ok.chan!.close();

    const reuse = await connectClient(relay.url, pattern, devicePub, generateKeyPair(), code);
    expect(await reuse.rejected).toBe("unpaired");

    const again = await connectClient(relay.url, pattern, devicePub, keys); // paired key, no code
    again.chan!.send({ t: "session.list" });
    expect(again.chan).toBeDefined();
  });
}

test("device reconnects to the relay after the connection drops and serves new sessions", async () => {
  const { sessions, first, devicePub } = await setup("XX");
  relay.dropDevice();
  await relay.waitDeviceConnect(2);
  const { code } = await link!.pairing();
  await connectClient(relay.url, "XX", devicePub, generateKeyPair(), code);
  await first;
  expect(sessions).toHaveLength(1);
});

test("approval callback can veto a valid code", async () => {
  relay = startRelay();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-remote-"));
  const identityFile = path.join(dir, "identity.json");
  const asked: string[] = [];
  link = createRemoteLink({ relayUrl: relay.url, pattern: "XX", identityFile, clientSecret: () => "k", approve: async (fp) => { asked.push(fp); return false; } });
  await link.start();
  const pub = Uint8Array.from(Buffer.from(JSON.parse(fs.readFileSync(identityFile, "utf8")).pub, "hex"));
  const { code } = await link.pairing();
  const c = await connectClient(relay.url, "XX", pub, generateKeyPair(), code);
  expect(await c.rejected).toBe("unpaired");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatch(/^[0-9a-f]{16}$/);
});
