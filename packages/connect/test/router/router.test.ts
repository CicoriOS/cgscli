import { afterEach, expect, test } from "bun:test";
import http2 from "node:http2";
import { Duplex } from "node:stream";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { createRouter, rootsFromHex, seal, keyId, makeWsCarrier, noiseResponder, type RouterImpl } from "../../src/router/index.ts";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const rootPriv = ed25519.utils.randomSecretKey();
const issuerPriv = ed25519.utils.randomSecretKey();
const roots = rootsFromHex([hex(ed25519.getPublicKey(rootPriv))]);
const gwPriv = x25519.utils.randomSecretKey();
const gwPub = x25519.getPublicKey(gwPriv);

function bundle(opts: { now?: number; version?: number; forgeRoot?: boolean } = {}) {
  const now = opts.now ?? Date.now();
  const issuerPub = ed25519.getPublicKey(issuerPriv);
  const cert = { key_id: keyId(issuerPub), public_key: b64(issuerPub), not_before: now - 1000, not_after: now + 3600_000 };
  const config = {
    version: opts.version ?? now, issued_at: now, expires_at: now + 1800_000, gateway_keys: [b64(gwPub)],
    endpoints: [{ id: "a", host: "gw.example.com", port: 443, tls: true }],
  };
  return { issuer_cert: seal("issuer_cert", opts.forgeRoot ? ed25519.utils.randomSecretKey() : rootPriv, enc(cert)), config: seal("tunnel_config", issuerPriv, enc(config)) };
}

// Local gateway: Noise responder over a WebSocket, HTTP/2 cleartext inside, answering as the origin.
const cleanup: (() => void)[] = [];
function startGateway() {
  const h2 = http2.createServer();
  h2.on("request", (rq, rs) => {
    rs.setHeader("X-CGS-Origin", "1");
    rs.end(`relay:${rq.method} ${rq.url}`);
  });
  type Conn = { duplex: Duplex; t: ReturnType<typeof noiseResponder>["transport"] | null };
  const conns = new WeakMap<object, Conn>();
  const srv = Bun.serve({
    port: 0,
    fetch: (r, s) => (s.upgrade(r) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, data) {
        let c = conns.get(ws);
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
        if (!c) {
          const { msg2, transport } = noiseResponder(gwPriv, bytes);
          const duplex = new Duplex({
            read() {},
            write(chunk, _e, cb) { ws.sendBinary(c!.t!.send.encrypt(new Uint8Array(chunk))); cb(); },
          });
          c = { duplex, t: transport };
          conns.set(ws, c);
          h2.emit("connection", duplex);
          ws.sendBinary(msg2);
          return;
        }
        c.duplex.push(c.t!.recv.decrypt(bytes));
      },
    },
  });
  cleanup.push(() => { srv.stop(true); h2.close(); });
  return srv.port;
}

let router: RouterImpl | null = null;
afterEach(() => { router?.stop(); router = null; cleanup.splice(0).forEach((f) => f()); });

const originOk = async (r: Request) => new Response(`direct:${new URL(r.url).pathname}`, { headers: { "X-CGS-Origin": "1" } });

test("direct path is used while it works, with the upstream origin rewritten", async () => {
  router = createRouter({ upstream: "https://api.example.com", roots, directFetch: originOk });
  const r = await router.fetch(new Request("http://local/api/device/tier?a=1"));
  expect(await r.text()).toBe("direct:/api/device/tier");
  expect(router.status().mode).toBe("direct");
});

test("direct failure switches to the relay and the request completes over Noise+HTTP/2", async () => {
  const port = startGateway();
  router = createRouter({
    upstream: "https://api.example.com", roots,
    carrier: makeWsCarrier(() => `ws://127.0.0.1:${port}/api/tunnel/v1`),
    directFetch: async (r) => { if (new URL(r.url).pathname === "/api/tunnel/health") return new Response("x", { status: 503 }); throw new Error("ECONNREFUSED"); },
    probeEveryMs: 3_600_000,
  });
  const v0 = router.status().version;
  router.setTunnel(bundle());
  const r = await router.fetch(new Request("http://local/v1/models?x=1"));
  expect(await r.text()).toBe("relay:GET /v1/models?x=1");
  expect(router.status().mode).toBe("relay");
  expect(router.status().version).toBeGreaterThan(v0);
  expect(router.status().endpoint).toBe("a@dns");
});

test("without a tunnel config a direct failure is a 502, not a hang", async () => {
  router = createRouter({ upstream: "https://api.example.com", roots, directFetch: async () => { throw new Error("down"); } });
  await expect(router.fetch(new Request("http://local/x"))).rejects.toThrow("down");
});

test("CDN error without the origin marker counts as direct failure; with it, it is the origin's answer", async () => {
  const port = startGateway();
  let withMarker = false;
  router = createRouter({
    upstream: "https://api.example.com", roots, probeEveryMs: 3_600_000,
    carrier: makeWsCarrier(() => `ws://127.0.0.1:${port}/api/tunnel/v1`),
    directFetch: async () => new Response("bad gateway", { status: 502, headers: withMarker ? { "X-CGS-Origin": "1" } : {} }),
  });
  router.setTunnel(bundle());
  withMarker = true;
  expect((await router.fetch(new Request("http://local/a"))).status).toBe(502);
  expect(router.status().mode).toBe("direct");
  withMarker = false;
  const r = await router.fetch(new Request("http://local/a"));
  expect(await r.text()).toBe("relay:GET /a");
});

test("non-idempotent request is not replayed after the direct answer was a CDN error", async () => {
  router = createRouter({ upstream: "https://api.example.com", roots, directFetch: async () => new Response("cdn", { status: 502 }), probeEveryMs: 3_600_000 });
  router.setTunnel(bundle());
  const r = await router.fetch(new Request("http://local/v1/chat", { method: "POST", body: "{}" }));
  expect(r.status).toBe(502);
  expect(await r.text()).toBe("cdn");
});

test("bundle verification rejects forged roots, tampering and expiry", () => {
  const r = createRouter({ upstream: "https://api.example.com", roots });
  expect(() => r.setTunnel(bundle({ forgeRoot: true }))).toThrow("unknown root");
  const bad = bundle();
  bad.config.body = b64(enc({ version: 1 }));
  expect(() => r.setTunnel(bad)).toThrow("signature");
  expect(() => r.setTunnel(bundle({ now: Date.now() - 2 * 3600_000 }))).toThrow(/expired/);
  expect(r.controlStatus().tunnel_configured).toBe(false);
  r.stop();
});

test("control endpoints: PUT/DELETE tunnel, status long-poll wakes on change", async () => {
  router = createRouter({ upstream: "https://api.example.com", roots });
  const status = async (q = "") => (await router!.handleControl(new Request(`http://x/_cgs-agent/v1/status${q}`)))!.json() as Promise<{ version: number; tunnel_configured: boolean }>;
  const s0 = await status();
  expect(s0.tunnel_configured).toBe(false);
  const waiting = status(`?after=${s0.version}`);
  const put = await router.handleControl(new Request("http://x/_cgs-agent/v1/tunnel", { method: "PUT", body: JSON.stringify(bundle()) }));
  expect(put!.status).toBe(200);
  const s1 = await waiting;
  expect(s1.version).toBeGreaterThan(s0.version);
  expect(s1.tunnel_configured).toBe(true);
  const bad = await router.handleControl(new Request("http://x/_cgs-agent/v1/tunnel", { method: "PUT", body: "{}" }));
  expect(bad!.status).toBe(400);
  expect((await router.handleControl(new Request("http://x/_cgs-agent/v1/tunnel", { method: "DELETE" })))!.status).toBe(204);
  expect((await status()).tunnel_configured).toBe(false);
  expect(await router.handleControl(new Request("http://x/other"))).toBeNull();
});
