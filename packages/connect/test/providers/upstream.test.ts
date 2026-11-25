import { expect, test } from "bun:test";
import { CGSCONNECT_ORIGIN, type ChannelEvent, type IdentityEvent, type Router } from "../../src/index.ts";
import { CHANNEL_PREFIX, createProviderHub, type ProviderHubImpl } from "../../src/providers/index.ts";
import { ChannelTracker, parseUpstream, transientFailure } from "../../src/providers/upstream.ts";

const H = "x-cgs-upstream";

function gateway(handler: (req: Request, n: number) => Response | Promise<Response>) {
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const r: Router = {
    async fetch(req) {
      seen.push({ url: new URL(req.url).pathname, headers: req.headers, body: req.body ? await req.clone().text() : "" });
      return handler(req, seen.length);
    },
    status: () => ({ version: 0, mode: "direct" }), subscribe: () => () => {}, setTunnel() {}, clearTunnel() {},
  };
  return { r, seen };
}
const call = (hub: ProviderHubImpl, channel = "cgs-claude") =>
  hub.fetch(new Request(`${CGSCONNECT_ORIGIN}${CHANNEL_PREFIX}${channel}/v1/messages`, { method: "POST", headers: { authorization: "Bearer client" }, body: "{}" }));

test("parseUpstream: tolerates unknown keys and junk, rejects other versions", () => {
  expect(parseUpstream("v=1; family=anthropic; persona=claude-code; channel=11; from=9; switched=1; limited=1; rotate=0; refresh=0; reason=usage_limit; future=x")).toMatchObject({ channel: 11, from: 9, switched: true, limited: true, rotate: false, reason: "usage_limit" });
  expect(parseUpstream("v=2; channel=1")).toBeNull();
  expect(parseUpstream("garbage")).toBeNull();
  expect(parseUpstream(null)).toBeNull();
  expect(parseUpstream("v=1; channel=abc; from=-3")).toMatchObject({ channel: undefined, from: undefined });
});

test("rotate=1 failures become the provider's own transient error, never a usage limit", () => {
  const u = parseUpstream("v=1; rotate=1; reason=no_credential")!;
  const claude = transientFailure("cgs-claude", 503, "no dedicated credential available", u)!;
  expect(claude.status).toBe(529);
  expect(JSON.parse(claude.body).error.type).toBe("overloaded_error");
  expect(transientFailure("cgs-codex", 502, "x", u)!.status).toBe(503);
  expect(JSON.parse(transientFailure("cgs-antigravity", 429, "x", u)!.body).error.status).toBe("UNAVAILABLE");
  for (const c of ["cgs-claude", "cgs-codex", "cgs-antigravity"] as const) {
    expect(transientFailure(c, 503, "x", u)!.body).not.toMatch(/usage.limit|QUOTA_EXHAUSTED|rate_limit/i);
  }
  expect(transientFailure("cgs-claude", 200, "x", u)).toBeNull();
  expect(transientFailure("cgs-claude", 503, "x", parseUpstream("v=1; rotate=0")!)).toBeNull();
});

test("hub: rotate=1 failure is rewritten, and the channel's wire session id changes once", async () => {
  const gw = gateway(() => new Response("no dedicated credential available", { status: 503, headers: { [H]: "v=1; channel=9; rotate=1; reason=no_credential" } }));
  const hub = createProviderHub({ router: gw.r });
  const events: IdentityEvent[] = [];
  hub.onIdentity((e) => events.push(e));
  const before = hub.sessionIdentity("cgs-claude", "sess-1");
  expect(before).toBe("sess-1");
  const res = await call(hub);
  expect(res.status).toBe(529);
  expect(events).toEqual([{ provider: "cgs-claude", epoch: 1, reason: "rotate: no_credential" }]);
  const after = hub.sessionIdentity("cgs-claude", "sess-1");
  expect(after).not.toBe("sess-1");
  expect(after).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Stable within an epoch, different per conversation and per channel.
  expect(hub.sessionIdentity("cgs-claude", "sess-1")).toBe(after);
  expect(hub.sessionIdentity("cgs-claude", "sess-2")).not.toBe(after);
  expect(hub.sessionIdentity("cgs-codex", "sess-1")).toBe("sess-1");
});

test("hub: the path prefix names the channel and is stripped; nothing about the channel is sent upstream", async () => {
  const gw = gateway(() => new Response("{}", { headers: { [H]: "v=1; channel=9; from=11; switched=1; refresh=1" } }));
  const hub = createProviderHub({ router: gw.r });
  await call(hub); await call(hub);
  for (const s of gw.seen) {
    expect(s.url).toBe("/v1/messages");
    expect([...s.headers.keys()].filter((k) => /channel|cgs-/.test(k))).toEqual([]);
    expect(s.body).not.toMatch(/channel/i);
  }
  expect((await hub.fetch(new Request(`${CGSCONNECT_ORIGIN}/v1/messages`))).status).toBe(404);
});

test("hub: a successful response with limited=1 only is passed through, identity unchanged", async () => {
  const gw = gateway(() => new Response("fine", { headers: { [H]: "v=1; channel=9; limited=1" } }));
  const hub = createProviderHub({ router: gw.r });
  const res = await call(hub);
  expect(await res.text()).toBe("fine");
  expect(hub.sessionIdentity("cgs-claude", "s")).toBe("s");
});

test("hub: without the header nothing changes", async () => {
  const gw = gateway(() => new Response("{}", { status: 503 }));
  const hub = createProviderHub({ router: gw.r });
  expect((await call(hub)).status).toBe(503);
  expect(hub.sessionIdentity("cgs-claude", "s")).toBe("s");
});

test("channel events: 11 -> 9 is announced with from/to, an unchanged channel is silent, lastChannel is read-only", async () => {
  let n = 0;
  const gw = gateway(() => new Response("{}", { headers: { [H]: ["v=1; channel=11", "v=1; channel=9; from=11; switched=1", "v=1; channel=9"][n++]! } }));
  const hub = createProviderHub({ router: gw.r });
  const evs: ChannelEvent[] = [];
  hub.onChannel((e) => evs.push(e));
  await call(hub); await call(hub); await call(hub);
  expect(evs).toEqual([{ provider: "cgs-claude", kind: "switched", from: 11, to: 9 }]);
  expect(hub.lastChannel("cgs-claude")).toBe(9);
  expect("setChannel" in hub).toBe(false);
});

test("switched=1 and refresh=1 each move the identity on, once per signal", async () => {
  let n = 0;
  const gw = gateway(() => new Response("{}", { headers: { [H]: ["v=1; channel=9; from=11; switched=1", "v=1; channel=9", "v=1; channel=9; limited=1; refresh=1"][n++]! } }));
  const hub = createProviderHub({ router: gw.r });
  const events: IdentityEvent[] = [];
  hub.onIdentity((e) => events.push(e));
  await call(hub); await call(hub); await call(hub);
  expect(events.map((e) => [e.epoch, e.reason])).toEqual([[1, "switched"], [2, "refresh"]]);
});

test("in-flight requests that predate a switch do not switch again", async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let n = 0;
  const gw = gateway(async () => {
    await gates[n++]!.promise;
    return new Response("{}", { headers: { [H]: "v=1; channel=9; switched=1; from=11" } });
  });
  const hub = createProviderHub({ router: gw.r });
  const events: IdentityEvent[] = [];
  hub.onIdentity((e) => events.push(e));
  const a = call(hub), b = call(hub);
  gates.forEach((g) => g.resolve());
  await Promise.all([a, b]);
  expect(events).toHaveLength(1);
});

test("ChannelTracker: NewAPI's `from` wins over our own memory", () => {
  const t = new ChannelTracker();
  expect(t.observe("cgs-claude", parseUpstream("v=1; channel=5")!)).toBeNull();
  expect(t.observe("cgs-claude", parseUpstream("v=1; channel=9; from=11; switched=1")!)).toEqual({ provider: "cgs-claude", from: 11, to: 9 });
});

test("hub: Claude requests get a full metadata.user_id, and device_id changes with the epoch, not with the conversation", async () => {
  let next = "v=1; channel=9";
  const gw = gateway(() => new Response("{}", { headers: { [H]: next } }));
  const hub = createProviderHub({ router: gw.r, deviceSeed: "seed" });
  const send = (session: string) => hub.fetch(new Request(`${CGSCONNECT_ORIGIN}${CHANNEL_PREFIX}cgs-claude/v1/messages?beta=true`, {
    method: "POST", body: JSON.stringify({ model: "m", metadata: { user_id: JSON.stringify({ session_id: session }) } }),
  }));
  const userId = (n: number) => JSON.parse(JSON.parse(gw.seen[n]!.body).metadata.user_id) as Record<string, string>;

  await send("s1"); await send("s2");
  expect(Object.keys(userId(0))).toEqual(["device_id", "account_uuid", "session_id"]);
  expect(userId(0)).toMatchObject({ account_uuid: "", session_id: "s1" });
  expect(userId(0).device_id).toMatch(/^[0-9a-f]{64}$/);
  expect(userId(1).device_id).toBe(userId(0).device_id);
  expect(JSON.parse(gw.seen[0]!.body).model).toBe("m");

  next = "v=1; channel=9; rotate=1";
  await send("s1");
  next = "v=1; channel=9";
  await send("s1");
  expect(userId(3).device_id).not.toBe(userId(0).device_id);
});

test("hub: bodies that are not Claude messages pass through untouched", async () => {
  const gw = gateway(() => new Response("{}"));
  const hub = createProviderHub({ router: gw.r });
  await hub.fetch(new Request(`${CGSCONNECT_ORIGIN}${CHANNEL_PREFIX}cgs-claude/v1/messages`, { method: "POST", body: "not json" }));
  await hub.fetch(new Request(`${CGSCONNECT_ORIGIN}${CHANNEL_PREFIX}cgs-codex/v1/codex/responses`, { method: "POST", body: '{"a":1}' }));
  expect(gw.seen.map((s) => s.body)).toEqual(["not json", '{"a":1}']);
});
