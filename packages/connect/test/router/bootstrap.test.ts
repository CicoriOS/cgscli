import { afterEach, expect, test } from "bun:test";
import { createRouter } from "../../src/router/index.ts";
import { bootstrap } from "../../src/router/bootstrap.ts";

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(true); });

/** A local "API server": answers HEALTH_PATH after `delayMs`, with or without the origin marker. */
function api(o: { delayMs?: number; marker?: boolean; status?: number } = {}) {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    await Bun.sleep(o.delayMs ?? 0);
    const h: Record<string, string> = o.marker === false ? {} : { "x-cgs-origin": "1" };
    const u = new URL(req.url);
    return new Response(u.pathname === "/api/tunnel/health" ? "ok" : `hit ${u.pathname}`, { status: o.status ?? 200, headers: h });
  } });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}
const dead = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") }); const u = `http://127.0.0.1:${s.port}`; s.stop(true); return u; };
const direct = (r: Request) => fetch(r);

test("bootstrap takes the first healthy candidate in list order, not the fastest", async () => {
  const preferred = api({ delayMs: 250 }), fast = api({ delayMs: 0 });
  expect((await bootstrap([new URL(preferred), new URL(fast)], { direct }))?.origin).toBe(new URL(preferred).origin);
  expect((await bootstrap([new URL(fast), new URL(preferred)], { direct }))?.origin).toBe(new URL(fast).origin);
});

test("a preferred candidate that is too slow is passed over once the patience runs out, and a failed one at once", async () => {
  const preferred = api({ delayMs: 700 }), fast = api({ delayMs: 0 });
  const t0 = Date.now();
  expect((await bootstrap([new URL(preferred), new URL(fast)], { direct, patienceMs: 150 }))?.origin).toBe(new URL(fast).origin);
  expect(Date.now() - t0).toBeLessThan(600);
  expect((await bootstrap([new URL(preferred), new URL(fast)], { direct, patienceMs: 3000 }))?.origin).toBe(new URL(preferred).origin);
  expect((await bootstrap([new URL(dead()), new URL(fast)], { direct, patienceMs: 3000 }))?.origin).toBe(new URL(fast).origin);
});

test("Bootstrap probes and requests leave through the proxy named by PI_PROXY (ahead of HTTP_PROXY); loopback and NO_PROXY hosts go direct", async () => {
  const seen: string[] = [];
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen.push(req.url); return new Response("ok", { headers: { "x-cgs-origin": "1" } }); } });
  servers.push(proxy);
  const env = { PI_PROXY: `http://127.0.0.1:${proxy.port}`, HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "skip.invalid" };
  const r = createRouter({ upstream: ["http://a.invalid", "http://b.invalid"], env, cloudflare: { enabled: true } });
  await r.ready();
  expect(r.upstream()).toBe("http://a.invalid");
  const res = await r.fetch(new Request("http://x.invalid/api/status"));
  expect(res.status).toBe(200);
  expect(seen).toContain("http://a.invalid/api/tunnel/health");
  expect(seen).toContain("http://b.invalid/api/tunnel/health");
  expect(seen.some((u) => u.startsWith("http://a.invalid/api/status"))).toBe(true);
  r.stop();
  const local = api();
  const direct2 = createRouter({ upstream: [local, api({ delayMs: 50 })], env });
  await direct2.ready();
  expect(direct2.upstream()).toBe(new URL(local).origin);
  expect(seen.some((u) => u.includes("127.0.0.1"))).toBe(false);
  direct2.stop();
});

test("an answer without the origin marker or with an error status is not healthy (a CDN made it up)", async () => {
  const fake = api({ marker: false }), broken = api({ status: 503 }), good = api({ delayMs: 80 });
  expect((await bootstrap([new URL(fake), new URL(broken), new URL(good)], { direct }))?.origin).toBe(new URL(good).origin);
  expect(await bootstrap([new URL(fake), new URL(dead())], { direct, timeoutMs: 500 })).toBeNull();
});

test("router sends requests (login included) to the Bootstrap winner, and fails over to another candidate when it dies", async () => {
  const a = api({ delayMs: 0 }), b = api({ delayMs: 60 });
  const stopA = servers[0]!;
  const r = createRouter({ upstream: [a, b] });
  await r.ready();
  expect(r.upstream()).toBe(new URL(a).origin);
  expect(await (await r.fetch(new Request("http://x.invalid/api/device/sessions"))).text()).toBe("hit /api/device/sessions");

  stopA.stop(true);
  const res = await r.fetch(new Request("http://x.invalid/api/status"));
  expect(await res.text()).toBe("hit /api/status");
  expect(r.upstream()).toBe(new URL(b).origin);
  r.stop();
});

test("a non-idempotent request is never replayed on another candidate after the first one failed", async () => {
  let hits = 0;
  const a = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { if (new URL(req.url).pathname === "/api/tunnel/health") return new Response("ok", { headers: { "x-cgs-origin": "1" } }); hits++; return new Response("", { status: 502 }); } });
  servers.push(a);
  const b = api({ delayMs: 60 });
  const r = createRouter({ upstream: [`http://127.0.0.1:${a.port}`, b] });
  await r.ready();
  const res = await r.fetch(new Request("http://x.invalid/v1/messages", { method: "POST", body: "{}" }));
  expect(res.status).toBe(502); // CDN-made failure on a POST: not retried elsewhere, no relay configured
  expect(hits).toBe(1);
  r.stop();
});
