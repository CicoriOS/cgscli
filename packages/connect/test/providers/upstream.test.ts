import { expect, test } from "bun:test";
import { CGSCONNECT_ORIGIN, type ChannelEvent, type Router } from "../../src/index.ts";
import { createProviderHub } from "../../src/providers/index.ts";
import { ChannelTracker, parseUpstream, refreshSession, usageLimitRewrite } from "../../src/providers/upstream.ts";

const claudeKey = (n: string) => `sk-ant-oat01-${n}`;
const H = "x-cgs-upstream";

function gateway(handler: (req: Request, n: number) => Response | Promise<Response>) {
  const seen: { headers: Headers; body: string }[] = [];
  const r: Router = {
    async fetch(req) {
      seen.push({ headers: req.headers, body: req.body ? await req.clone().text() : "" });
      return handler(req, seen.length);
    },
    status: () => ({ version: 0, mode: "direct" }), subscribe: () => () => {}, setTunnel() {}, clearTunnel() {},
  };
  return { r, seen };
}

function hubWith(r: Router, now?: () => number) {
  const hub = createProviderHub({ router: r, now });
  hub.pushCredentials([
    { provider: "cgs-claude", id: "a", key: claudeKey("a") },
    { provider: "cgs-claude", id: "b", key: claudeKey("b") },
  ]);
  return hub;
}

const call = (hub: ReturnType<typeof hubWith>, body = "{}", key = claudeKey("a")) =>
  hub.fetch(new Request(`${CGSCONNECT_ORIGIN}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-claude-code-session-id": "old-session" }, body }));

test("parseUpstream: tolerates unknown keys and junk, rejects other versions", () => {
  expect(parseUpstream("v=1; family=anthropic; persona=claude-code; channel=11; from=9; switched=1; limited=1; rotate=0; refresh=0; reason=usage_limit; future=x")).toMatchObject({ channel: 11, from: 9, switched: true, limited: true, rotate: false, reason: "usage_limit" });
  expect(parseUpstream("v=2; channel=1")).toBeNull();
  expect(parseUpstream("garbage")).toBeNull();
  expect(parseUpstream(null)).toBeNull();
  expect(parseUpstream("v=1; channel=abc; from=-3")).toMatchObject({ channel: undefined, from: undefined });
});

test("rotate=1 on a 503 becomes a usage-limit 429 in the provider's own wire format, so omp rotates", () => {
  const u = parseUpstream("v=1; rotate=1; reason=no_credential")!;
  const claude = usageLimitRewrite("cgs-claude", 503, "no dedicated credential available", u)!;
  expect(claude.status).toBe(429);
  expect(JSON.parse(claude.body).error.type).toBe("rate_limit_error");
  expect(claude.body.toLowerCase()).toContain("usage limit reached");
  expect(usageLimitRewrite("cgs-codex", 503, "x", u)!.body).toContain("usage_limit_reached");
  expect(usageLimitRewrite("cgs-antigravity", 503, "x", u)!.body).toContain("QUOTA_EXHAUSTED");
  // Already rotating statuses, successes and rotate=0 are left alone.
  expect(usageLimitRewrite("cgs-claude", 429, "x", u)).toBeNull();
  expect(usageLimitRewrite("cgs-claude", 200, "x", u)).toBeNull();
  expect(usageLimitRewrite("cgs-claude", 503, "x", parseUpstream("v=1; rotate=0")!)).toBeNull();
});

test("hub: rotate=1 failure is rewritten to 429, the slot is cooled for retry-after, and a rotation event fires", async () => {
  const t = 1_000_000;
  const gw = gateway(() => new Response("no dedicated credential available for tenant", { status: 503, headers: { [H]: "v=1; family=anthropic; channel=9; rotate=1; reason=no_credential; retry-after=60" } }));
  const hub = hubWith(gw.r, () => t);
  const events: string[] = [];
  hub.onRotation((e) => events.push(`${e.from}->${e.to}:${e.reason}`));
  const res = await call(hub);
  expect(res.status).toBe(429);
  expect(await res.text()).toContain("rate_limit_error");
  expect(events).toEqual(["a->b:no_credential"]);
  expect(hub.currentSlot("cgs-claude")!.id).toBe("b");
});

test("hub: cooling by retry-after ends on time", async () => {
  let t = 5_000;
  const gw = gateway(() => new Response("x", { status: 200, headers: { [H]: "v=1; channel=9; rotate=1; retry-after=60" } }));
  const hub = hubWith(gw.r, () => t);
  await call(hub);
  expect(hub.currentSlot("cgs-claude")!.id).toBe("b");
  t += 59_000;
  expect(hub.currentSlot("cgs-claude")!.id).toBe("b");
  t += 2_000;
  expect(hub.currentSlot("cgs-claude")!.id).toBe("a");
});

test("hub: a 2xx with limited=1 passes through untouched", async () => {
  const gw = gateway(() => new Response("ok-body", { status: 200, headers: { [H]: "v=1; channel=9; from=11; switched=1; limited=1; rotate=0" } }));
  const hub = hubWith(gw.r);
  const res = await call(hub);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok-body");
  expect(hub.currentSlot("cgs-claude")!.id).toBe("a");
});

test("hub: without the header behaviour is the old one", async () => {
  const gw = gateway(() => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Usage limit reached" } }), { status: 429 }));
  const hub = hubWith(gw.r);
  const events: string[] = [];
  hub.onRotation((e) => events.push(e.reason));
  const res = await call(hub);
  expect(res.status).toBe(429);
  expect(events).toEqual(["usage-limit"]);
});

test("channel events: 11 -> 9 is announced with from/to, an unchanged channel is silent, lastChannel is read-only", async () => {
  let n = 0;
  const gw = gateway(() => new Response("{}", { headers: { [H]: ["v=1; channel=11", "v=1; channel=9; from=11; switched=1", "v=1; channel=9"][n++]! } }));
  const hub = hubWith(gw.r);
  const evs: ChannelEvent[] = [];
  hub.onChannel((e) => evs.push(e));
  await call(hub); await call(hub); await call(hub);
  expect(evs).toEqual([{ provider: "cgs-claude", kind: "switched", from: 11, to: 9 }]);
  expect(hub.lastChannel("cgs-claude")).toBe(9);
  expect("setChannel" in hub).toBe(false);
});

test("pinned channel refresh (refresh=1): event fires and the next request gets a fresh session id, device_id kept", async () => {
  const meta = (s: string) => JSON.stringify({ metadata: { user_id: JSON.stringify({ device_id: "dev", account_uuid: "acc", session_id: s }) } });
  let n = 0;
  const gw = gateway(() => new Response("{}", { headers: { [H]: n++ === 0 ? "v=1; channel=9; limited=1; refresh=1" : "v=1; channel=9" } }));
  const hub = hubWith(gw.r);
  const evs: ChannelEvent[] = [];
  hub.onChannel((e) => evs.push(e));
  await call(hub, meta("s1"));
  expect(evs).toEqual([{ provider: "cgs-claude", kind: "refreshed", to: 9 }]);
  await call(hub, meta("s1"));
  const second = gw.seen[1]!;
  const uid = JSON.parse(JSON.parse(second.body).metadata.user_id);
  expect(uid.session_id).not.toBe("s1");
  expect(uid).toMatchObject({ device_id: "dev", account_uuid: "acc" });
  expect(second.headers.get("x-claude-code-session-id")).not.toBe("old-session");
  // Only that one request is refreshed; the session id then stays stable.
  await call(hub, meta("s1"));
  expect(JSON.parse(JSON.parse(gw.seen[2]!.body).metadata.user_id).session_id).toBe("s1");
});

test("refreshSession leaves opaque user ids alone", () => {
  const h = new Headers();
  const body = JSON.stringify({ metadata: { user_id: "user_abc_account__session_xyz" } });
  expect(refreshSession("cgs-claude", h, body)).toBe(body);
  expect(refreshSession("cgs-codex", h, body)).toBe(body);
});

test("the client never names or hints a channel in what it sends", async () => {
  const gw = gateway(() => new Response("{}", { headers: { [H]: "v=1; channel=9; from=11; switched=1; refresh=1" } }));
  const hub = hubWith(gw.r);
  await call(hub); await call(hub);
  for (const s of gw.seen) {
    expect([...s.headers.keys()].filter((k) => /channel|cgs-/.test(k))).toEqual([]);
    expect(s.body).not.toMatch(/channel/i);
  }
});

test("ChannelTracker: NewAPI's `from` wins over our own memory", () => {
  const t = new ChannelTracker();
  expect(t.observe("cgs-claude", parseUpstream("v=1; channel=5")!)).toBeNull();
  expect(t.observe("cgs-claude", parseUpstream("v=1; channel=9; from=11; switched=1")!)).toEqual({ provider: "cgs-claude", from: 11, to: 9 });
});
