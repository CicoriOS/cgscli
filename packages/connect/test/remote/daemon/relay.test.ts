import { afterEach, expect, test } from "bun:test";
import { DeviceRelay, reconnectDelayMs, remoteApi, type RelayCallbacks } from "../../../src/remote/daemon/relay.ts";
import { parseEnvelope } from "../../../src/remote/envelope.ts";

// ---- helpers -----------------------------------------------------------------------------------------------------------

const cleanups: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const x of cleanups.splice(0)) x.stop();
});
function track<T extends { stop(): void }>(x: T): T {
  cleanups.push(x);
  return x;
}

// Condition polling against real sockets; the deadline only bounds a hang, it is not a guessed wait.
async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const ctlFrame = (sid: string, seq: number, payload: { op: string; reason?: string }) => ({ v: 1, type: "ctl", sid, seq, payload });
const dataFrame = (sid: string, seq: number, bytes: number[]) => ({ v: 1, type: "data", sid, seq, payload: b64(bytes) });

function callbacks() {
  const ev = { opened: [] as string[], closed: [] as string[], data: [] as { sid: string; bytes: number[] }[], disconnected: [] as number[] };
  const cb: RelayCallbacks = {
    open: (sid) => ev.opened.push(sid),
    data: (sid, bytes) => ev.data.push({ sid, bytes: [...bytes] }),
    close: (sid) => ev.closed.push(sid),
    disconnected: (code) => ev.disconnected.push(code),
  };
  return { cb, ev };
}

function device(baseUrl: string, clientSecret = "s3cret") {
  const { cb, ev } = callbacks();
  const dev = track(new DeviceRelay({ baseUrl, clientSecret }, cb));
  return { dev, ev };
}

// ---- fake relay: a Bun WebSocket server on /relay that records every upgrade and every device frame ----------------

type Ws = Bun.ServerWebSocket<{ path: string }>;
interface FakeRelay {
  baseUrl: string;
  upgrades: { path: string; auth: string | null }[];
  inbound: string[];
  say(frame: unknown): void;
  closeLive(code: number): void;
  stop(): void;
}
function startFakeRelay(): FakeRelay {
  const upgrades: FakeRelay["upgrades"] = [];
  const inbound: string[] = [];
  const sockets: Ws[] = [];
  const srv = Bun.serve<{ path: string }>({
    port: 0,
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      upgrades.push({ path, auth: req.headers.get("authorization") });
      if (path === "/relay" && server.upgrade(req, { data: { path } })) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
      },
      message(_ws, msg) {
        inbound.push(String(msg));
      },
    },
  });
  const live = (): Ws => {
    const ws = sockets.at(-1);
    if (!ws) throw new Error("no device socket");
    return ws;
  };
  return {
    baseUrl: `http://127.0.0.1:${srv.port}`,
    upgrades,
    inbound,
    say: (frame) => live().send(JSON.stringify(frame)),
    closeLive: (code) => live().close(code, "test"),
    stop: () => srv.stop(true),
  };
}

// ---- fake HTTP server for remoteApi and redirect targets ----------------------------------------------------------------

interface HttpReq { method: string; path: string; auth: string | null; contentType: string | null; body: string }
function startHttp(handle: (req: Request) => Response): { baseUrl: string; requests: HttpReq[]; stop(): void } {
  const requests: HttpReq[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body,
      });
      return handle(req);
    },
  });
  return track({ baseUrl: `http://127.0.0.1:${srv.port}`, requests, stop: () => srv.stop(true) });
}

// ---- constructor, URL policy, backoff ----------------------------------------------------------------------------------

test("constructor accepts https and loopback http, refuses other http, URL credentials, and an empty secret", () => {
  const { cb } = callbacks();
  const make = (baseUrl: string, clientSecret = "s") => () => track(new DeviceRelay({ baseUrl, clientSecret }, cb));
  expect(make("https://cgs.example")).not.toThrow();
  expect(make("http://localhost:3000")).not.toThrow();
  expect(make("http://127.0.0.1:3000")).not.toThrow();
  expect(make("http://[::1]:3000")).not.toThrow();
  expect(make("http://cgs.example")).toThrow(/^relay_url_insecure$/);
  expect(make("https://u:p@cgs.example")).toThrow(/^relay_url_credentials$/);
  expect(make("https://cgs.example", "")).toThrow(/^client_secret_missing$/);
});

test("reconnect delay doubles from 1 s and is capped at 30 s", () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  expect(reconnectDelayMs(200)).toBe(30000);
});

// ---- link behaviour against the fake relay -----------------------------------------------------------------------------

test("dials /relay with the Bearer credential and reports online", async () => {
  const relay = track(startFakeRelay());
  const { dev } = device(relay.baseUrl, "s3cret");
  expect(dev.online).toBe(false);
  dev.start();
  await until(() => dev.online, "online");
  expect(relay.upgrades[0]).toEqual({ path: "/relay", auth: "Bearer s3cret" });
  dev.stop();
});

test("sessions open, data flows both ways per sid, unknown sids are dropped, ctl close ends the session", async () => {
  const relay = track(startFakeRelay());
  const { dev, ev } = device(relay.baseUrl);
  dev.start();
  await until(() => dev.online, "online");

  relay.say(ctlFrame("s1", 0, { op: "open" }));
  await until(() => ev.opened.length === 1, "open s1");
  expect(ev.opened).toEqual(["s1"]);

  // Frames on one socket arrive in order, so the trailing s1 frame proves the unknown-sid send was never emitted.
  dev.send("s1", Uint8Array.of(1, 2, 3));
  dev.send("s1", Uint8Array.of(250));
  dev.send("ghost", Uint8Array.of(9));
  dev.send("s1", Uint8Array.of(42));
  await until(() => relay.inbound.length === 3, "three data frames");
  expect(relay.inbound.map((s) => parseEnvelope(s))).toEqual([
    dataFrame("s1", 0, [1, 2, 3]),
    dataFrame("s1", 1, [250]),
    dataFrame("s1", 2, [42]),
  ]);

  // Same ordering argument for inbound: the ghost frame is processed before the s1 frame, so only s1 is reported.
  relay.say(dataFrame("ghost", 1, [5]));
  relay.say(dataFrame("s1", 0, [7, 8]));
  await until(() => ev.data.length === 1, "inbound data");
  expect(ev.data).toEqual([{ sid: "s1", bytes: [7, 8] }]);

  relay.say(ctlFrame("s1", 1, { op: "close" }));
  await until(() => ev.closed.length === 1, "close s1");
  expect(ev.closed).toEqual(["s1"]);

  // s1 is gone: its send is dropped. A fresh s2 sends after it, so index 3 must be s2, not s1.
  relay.say(ctlFrame("s2", 2, { op: "open" }));
  await until(() => ev.opened.length === 2, "open s2");
  dev.send("s1", Uint8Array.of(4));
  dev.send("s2", Uint8Array.of(5));
  await until(() => relay.inbound.length === 4, "s2 frame");
  expect(parseEnvelope(relay.inbound[3] ?? "")).toEqual(dataFrame("s2", 0, [5]));
  dev.stop();
});

test("a dropped link closes every session, reports the close code, and reconnects", async () => {
  const relay = track(startFakeRelay());
  const { dev, ev } = device(relay.baseUrl);
  dev.start();
  await until(() => dev.online, "online");
  relay.say(ctlFrame("s1", 0, { op: "open" }));
  await until(() => ev.opened.length === 1, "open s1");

  relay.closeLive(1011);
  await until(() => ev.disconnected.length === 1, "disconnected");
  expect(ev.disconnected).toEqual([1011]);
  expect(ev.closed).toEqual(["s1"]);
  expect(dev.online).toBe(false);

  await until(() => relay.upgrades.length === 2 && dev.online, "reconnected");
  expect(relay.upgrades[1]).toEqual({ path: "/relay", auth: "Bearer s3cret" });
  dev.stop();
});

test("stop() sends ctl close for live sessions, fires close, and does not reconnect", async () => {
  const relay = track(startFakeRelay());
  const { dev, ev } = device(relay.baseUrl);
  dev.start();
  await until(() => dev.online, "online");
  relay.say(ctlFrame("s1", 0, { op: "open" }));
  await until(() => ev.opened.length === 1, "open s1");

  dev.stop();
  expect(ev.closed).toEqual(["s1"]);
  expect(dev.online).toBe(false);
  await until(() => relay.inbound.length === 1, "ctl close frame");
  expect(parseEnvelope(relay.inbound[0] ?? "")).toEqual(ctlFrame("s1", 0, { op: "close", reason: "stopped" }));

  // Real-time window by design: the reconnect backoff is a wall-clock timer and no event marks "the timer would have
  // fired". This waits past the first reconnect delay (1 s) to show a stopped link does not dial again.
  await Bun.sleep(1200);
  expect(relay.upgrades.length).toBe(1);
  expect(ev.disconnected).toEqual([]);
});

test("a stop/start cycle ignores the old socket's close", async () => {
  const relay = track(startFakeRelay());
  const { dev, ev } = device(relay.baseUrl);
  dev.start();
  await until(() => dev.online, "online");

  dev.stop();
  dev.start();
  await until(() => relay.upgrades.length === 2 && dev.online, "second connection");
  // Real-time drain by design: the old socket's close handshake is not observable from outside, so this gives its
  // stale close event a chance to arrive before asserting that it reported nothing.
  await Bun.sleep(50);
  expect(ev.disconnected).toEqual([]);
  expect(dev.online).toBe(true);
  dev.stop();
});

test("a redirect on /relay is not followed, so the Bearer credential never reaches the target", async () => {
  const target = startHttp(() => Response.json({ ok: true }));
  const redirector = startHttp(() => new Response(null, { status: 302, headers: { location: `${target.baseUrl}/steal` } }));
  const { dev, ev } = device(redirector.baseUrl, "s3cret");
  dev.start();
  await until(() => ev.disconnected.length > 0, "disconnected after redirect");
  expect(dev.online).toBe(false);
  expect(target.requests).toEqual([]);
  dev.stop();
});

// ---- remoteApi ---------------------------------------------------------------------------------------------------------

test("remoteApi GET reads {allowed, enabled} with a Bearer credential", async () => {
  const http = startHttp(() => Response.json({ success: true, data: { allowed: true, enabled: false } }));
  expect(await remoteApi({ baseUrl: http.baseUrl, clientSecret: "s3cret" })).toEqual({ allowed: true, enabled: false });
  expect(http.requests).toEqual([{ method: "GET", path: "/api/device/remote", auth: "Bearer s3cret", contentType: null, body: "" }]);
});

test("remoteApi PUT sends {enabled} as JSON and returns the new state", async () => {
  const http = startHttp(() => Response.json({ success: true, data: { allowed: true, enabled: true } }));
  expect(await remoteApi({ baseUrl: http.baseUrl, clientSecret: "s3cret" }, true)).toEqual({ allowed: true, enabled: true });
  expect(http.requests).toEqual([
    { method: "PUT", path: "/api/device/remote", auth: "Bearer s3cret", contentType: "application/json", body: '{"enabled":true}' },
  ]);
});

test("remoteApi maps 403 remote_not_allowed to the fixed error", async () => {
  const http = startHttp(() => new Response(JSON.stringify({ error: "remote_not_allowed" }), { status: 403, headers: { "content-type": "application/json" } }));
  await expect(remoteApi({ baseUrl: http.baseUrl, clientSecret: "s3cret" })).rejects.toThrow(/^remote_not_allowed$/);
});

test("remoteApi does not follow redirects and reports a sanitized error", async () => {
  const target = startHttp(() => Response.json({ success: true, data: { allowed: true, enabled: true } }));
  const redirector = startHttp(() => new Response(null, { status: 302, headers: { location: `${target.baseUrl}/api/device/remote` } }));
  await expect(remoteApi({ baseUrl: redirector.baseUrl, clientSecret: "s3cret" })).rejects.toThrow(/^remote_api_http_302$/);
  expect(target.requests).toEqual([]);

  const failing = startHttp(() => new Response("upstream says Bearer s3cret", { status: 500 }));
  const err: unknown = await remoteApi({ baseUrl: failing.baseUrl, clientSecret: "s3cret" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("remote_api_http_500");
});

test("remoteApi rejects a malformed body and refuses insecure base URLs without sending anything", async () => {
  const bad = startHttp(() => Response.json({ success: true, data: { allowed: "yes" } }));
  await expect(remoteApi({ baseUrl: bad.baseUrl, clientSecret: "s3cret" })).rejects.toThrow(/^remote_api_bad_response$/);

  await expect(remoteApi({ baseUrl: "http://cgs.example", clientSecret: "s3cret" })).rejects.toThrow(/^relay_url_insecure$/);
});
