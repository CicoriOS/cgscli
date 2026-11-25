import { expect, test } from "bun:test";
import { CGSCONNECT_ORIGIN, type Router } from "../../src/index.ts";
import { buildManifest, channelForModel, createProviderHub, isRotationNotice, slotShapeError } from "../../src/providers/index.ts";
import { registerChannels } from "../../../../plugin/omp-extension/index.ts";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const codexKey = (acct: string) => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: acct } });
const claudeKey = (n: string) => `sk-ant-oat01-${n}`;


function router(handler: (req: Request) => Response | Promise<Response>): Router & { seen: { url: string; auth: string | null }[] } {
  const seen: { url: string; auth: string | null }[] = [];
  return {
    seen,
    async fetch(r) { seen.push({ url: new URL(r.url).pathname + new URL(r.url).search, auth: r.headers.get("authorization") }); return handler(r); },
    status: () => ({ version: 0, mode: "direct" }), subscribe: () => () => {}, setTunnel() {}, clearTunnel() {},
  };
}

test("channel routing and manifest: non-chat ids dropped, prices mapped, base URLs per channel", () => {
  expect(channelForModel("claude-sonnet-4")).toBe("cgs-claude");
  expect(channelForModel("gemini-3-pro")).toBe("cgs-antigravity");
  expect(channelForModel("gpt-5-codex")).toBe("cgs-codex");
  expect(channelForModel("deepseek-v4")).toBe("cgs-openai");
  expect(channelForModel("text-embedding-3")).toBeNull();
  const m = buildManifest("http://x/t/k", ["claude-a", "gpt-5", "whisper-1", "glm-5"], { "claude-a": { input: 21, output: 105, cache_read: 2 } });
  expect(m.providers.map((p) => [p.id, p.baseUrl])).toEqual([["cgs-claude", "http://x/t/k"], ["cgs-codex", "http://x/t/k/v1"], ["cgs-openai", "http://x/t/k/v1"]]);
  expect(m.providers[0]!.models[0]!.price).toEqual({ input: 21, output: 105, cacheRead: 2, cacheWrite: 0 });
});

test("slot shapes follow the vendors' detection rules", () => {
  expect(slotShapeError("cgs-claude", claudeKey("a"))).toBeNull();
  expect(slotShapeError("cgs-claude", "plain")).not.toBeNull();
  expect(slotShapeError("cgs-codex", codexKey("acct"))).toBeNull();
  expect(slotShapeError("cgs-codex", jwt({}))).not.toBeNull();
  expect(slotShapeError("cgs-antigravity", JSON.stringify({ token: "t", projectId: "p" }))).toBeNull();
  expect(slotShapeError("cgs-antigravity", JSON.stringify({ token: "t" }))).not.toBeNull();
});

test("only quota-exhausted notices count as rotation notices, not rolling rate limits", () => {
  expect(isRotationNotice("cgs-codex", 429, '{"error":{"type":"usage_limit_reached"}}')).toBe(true);
  expect(isRotationNotice("cgs-codex", 429, '{"error":{"type":"rate_limit_exceeded"}}')).toBe(false);
  expect(isRotationNotice("cgs-antigravity", 429, '{"error":{"details":[{"reason":"QUOTA_EXHAUSTED"}]}}')).toBe(true);
  expect(isRotationNotice("cgs-antigravity", 429, '{"error":{"details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}')).toBe(false);
  expect(isRotationNotice("cgs-claude", 402, "Usage limit reached")).toBe(true);
  expect(isRotationNotice("cgs-claude", 200, "Usage limit reached")).toBe(false);
});

test("proxy: origin-gated, forwards through the router, relays the notice unchanged and emits a rotation event", async () => {
  let n = 0;
  const r = router(() => (++n === 1 ? new Response('{"error":{"message":"usage limit reached"}}', { status: 429 }) : new Response("ok")));
  const hub = createProviderHub({ router: r, models: ["claude-a"] });
  hub.pushCredentials([{ provider: "cgs-claude", id: "s1", key: claudeKey("1") }, { provider: "cgs-claude", id: "s2", key: claudeKey("2") }]);
  const events: unknown[] = [];
  hub.onRotation((e) => events.push(e));

  expect((await hub.fetch(new Request("http://elsewhere.example/v1/messages"))).status).toBe(403);

  const res = await hub.fetch(new Request(`${CGSCONNECT_ORIGIN}/v1/messages?q=1`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${claudeKey("1")}` } }));
  expect(res.status).toBe(429);
  expect(await res.text()).toContain("usage limit reached");
  expect(r.seen[0]).toEqual({ url: "/v1/messages?q=1", auth: `Bearer ${claudeKey("1")}` });
  expect(events).toEqual([{ provider: "cgs-claude", from: "s1", to: "s2", reason: "usage-limit" }]);
  expect(hub.currentSlot("cgs-claude")!.id).toBe("s2");

  const ok = await hub.fetch(new Request(`${CGSCONNECT_ORIGIN}/v1/messages`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${claudeKey("2")}` } }));
  expect(await ok.text()).toBe("ok");
  expect(events).toHaveLength(1);
});

test("last slot exhausted is reported as such", async () => {
  const hub = createProviderHub({ router: router(() => new Response('{"error":{"type":"usage_limit_reached"}}', { status: 429 })) });
  hub.pushCredentials([{ provider: "cgs-codex", id: "only", key: codexKey("a") }]);
  const events: { to: string; reason: string }[] = [];
  hub.onRotation((e) => events.push(e));
  await (await hub.fetch(new Request(`${CGSCONNECT_ORIGIN}/v1/codex/responses`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${codexKey("a")}` } }))).text();
  expect(events[0]).toMatchObject({ to: "", reason: "usage-limit; all slots exhausted" });
});

test("pushCredentials rejects a malformed slot without replacing the current set", () => {
  const hub = createProviderHub({ router: router(() => new Response("")) });
  hub.pushCredentials([{ provider: "cgs-claude", id: "ok", key: claudeKey("1") }]);
  expect(() => hub.pushCredentials([{ provider: "cgs-codex", id: "bad", key: "nope" }])).toThrow("Codex key");
  expect(hub.currentSlot("cgs-claude")!.id).toBe("ok");
});

test("extension registers providers with oauth from the live manifest and hands out the current slot, through cgsconnect by direct call", async () => {
  const hub = createProviderHub({ router: router(() => new Response("")), models: ["claude-a", "gpt-5"] });
  hub.pushCredentials([{ provider: "cgs-claude", id: "s1", key: claudeKey("1") }]);
  const reg: Record<string, any> = {};
  await registerChannels({ registerProvider: (n, c) => void (reg[n] = c), registerCommand: () => {} }, (i, init) => hub.fetch(new Request(i, init)));
  expect(Object.keys(reg).sort()).toEqual(["cgs-claude", "cgs-codex"]);
  expect(reg["cgs-claude"].api).toBe("anthropic-messages");
  expect(reg["cgs-claude"].apiKey).toBe("CGS_CLIENT_SECRET");
  const cred = await reg["cgs-claude"].oauth.login();
  expect(reg["cgs-claude"].oauth.getApiKey(cred)).toBe(claudeKey("1"));
  expect(cred.refresh).toBe("s1");
});
