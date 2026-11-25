import { expect, test } from "bun:test";
import type { Router } from "../../src/contracts.ts";
import { Poller, normalizeUsage } from "../../src/router/poller.ts";

function fakeRouter(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const tunnels: unknown[] = [];
  let cleared = 0;
  const router: Router = {
    async fetch(req) { const p = new URL(req.url).pathname; calls.push(`${p} ${req.headers.get("authorization")}`); return (routes[p] ?? (() => new Response("", { status: 404 })))(); },
    status: () => ({ version: 0, mode: "direct" }), subscribe: () => () => {},
    setTunnel: (b) => void tunnels.push(b), clearTunnel: () => { cleared++; },
  };
  return { router, calls, tunnels, cleared: () => cleared };
}
const ok = (data: unknown) => () => new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
const creds = () => ({ baseUrl: "https://cgs.test/", clientSecret: "k" });
const client = { os: "Linux", version: "1" };

test("tier success hands the signed bundle to the router and applies the layout only once", async () => {
  const f = fakeRouter({ "/api/device/tier": ok({ tier: "lite", username: "u" }), "/api/device/tunnel": ok({ enabled: true, bundle: { b: 1 } }), "/api/device/layout": ok({ orchestrator: "x" }), "/api/device/usage": ok({}) });
  const layouts: unknown[] = [];
  const p = new Poller({ router: f.router, credentials: creds, client, onLayout: (l) => layouts.push(l) });
  expect(await p.refreshTier()).toBe("ok");
  expect(await p.refreshTier()).toBe("ok");
  p.stop();
  expect(f.tunnels).toEqual([{ b: 1 }, { b: 1 }]);
  expect(layouts).toHaveLength(1);
  expect(f.calls[0]).toBe("/api/device/tier Bearer k");
});

test("server without a tunnel clears it; 401 logs out and stops usage polling", async () => {
  let status = 200;
  const f = fakeRouter({ "/api/device/tier": () => (status === 401 ? new Response("", { status }) : ok({ tier: "lite" })()), "/api/device/tunnel": ok({ enabled: false }), "/api/device/layout": ok(null), "/api/device/usage": ok({ tier: "lite", balance: { quota: 5 } }) });
  let out = 0;
  const p = new Poller({ router: f.router, credentials: creds, client, onLoggedOut: () => out++ });
  await p.refreshTier();
  expect(f.cleared()).toBe(1);
  status = 401;
  expect(await p.refreshTier()).toBe("unauthorized");
  expect(out).toBe(1);
  expect(await p.refreshUsage()).toBe("unauthorized");
  p.stop();
});

test("a failed usage refresh keeps the last value and marks it stale", async () => {
  let fail = false;
  const f = fakeRouter({ "/api/device/usage": () => (fail ? new Response("", { status: 500 }) : ok({ tier: "lite", balance: { quota: 5 }, subscriptions: [{ amount_total: 0, reset_period: "weird" }] })()) });
  const seen: { stale: boolean; has: boolean }[] = [];
  const p = new Poller({ router: f.router, credentials: creds, client, onUsage: (u) => seen.push({ stale: u.stale, has: u.usage !== null }) });
  await p.refreshUsage();
  fail = true;
  await p.refreshUsage();
  expect(seen).toEqual([{ stale: false, has: true }, { stale: true, has: true }]);
  expect(normalizeUsage({ subscriptions: [{ amount_total: 0, reset_period: "weird" }] })!.subscriptions[0]).toMatchObject({ unlimited: true, resetPeriod: "never" });
});
