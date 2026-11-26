import { expect, test } from "bun:test";
import { CGSCONNECT_ORIGIN, type Router } from "../../src/index.ts";
import { buildManifest, channelForModel, channelOfPath, createProviderHub } from "../../src/providers/index.ts";
import { registerChannels } from "../../../../plugin/omp-extension/index.ts";

function router(): Router {
  return { fetch: async () => new Response(""), status: () => ({ version: 0, mode: "direct" }), subscribe: () => () => {}, setTunnel() {}, clearTunnel() {} };
}

test("channel routing and manifest: non-chat ids dropped, prices mapped, base URLs carry the channel prefix", () => {
  expect(channelForModel("claude-sonnet-4")).toBe("cgs-claude");
  expect(channelForModel("gemini-3-pro")).toBe("cgs-antigravity");
  expect(channelForModel("gpt-5-codex")).toBe("cgs-codex");
  expect(channelForModel("deepseek-v4")).toBe("cgs-openai");
  expect(channelForModel("text-embedding-3")).toBeNull();
  const m = buildManifest("http://x", ["claude-a", "gpt-5", "whisper-1", "glm-5"], { "claude-a": { input: 21, output: 105, cache_read: 2 } });
  expect(m.providers.map((p) => [p.id, p.baseUrl])).toEqual([["cgs-claude", "http://x/_cgsconnect/c/cgs-claude"], ["cgs-codex", "http://x/_cgsconnect/c/cgs-codex/v1"], ["cgs-openai", "http://x/_cgsconnect/c/cgs-openai/v1"]]);
  expect(m.providers[0]!.models[0]!.price).toEqual({ input: 21, output: 105, cacheRead: 2, cacheWrite: 0 });
});

test("models declare picture input by family, and the extension registers it (omp drops pictures for text-only models)", async () => {
  const m = buildManifest("http://x", ["claude-a", "gemini-3-pro", "gpt-5", "deepseek-v4.1-flash", "glm-5"]);
  const input = Object.fromEntries(m.providers.flatMap((p) => p.models.map((x) => [x.id, x.input])));
  expect(input).toEqual({ "claude-a": ["text", "image"], "gemini-3-pro": ["text", "image"], "gpt-5": ["text", "image"], "deepseek-v4.1-flash": ["text", "image"], "glm-5": ["text"] });
  const hub = createProviderHub({ router: router(), models: ["deepseek-v4.1-flash", "glm-5"] });
  const reg: Record<string, any> = {};
  await registerChannels({ registerProvider: (n, c) => void (reg[n] = c), registerCommand: () => {} }, (i, init) => hub.fetch(new Request(i, init)));
  expect(Object.fromEntries(reg["cgs-openai"].models.map((x: any) => [x.id, x.input]))).toEqual({ "deepseek-v4.1-flash": ["text", "image"], "glm-5": ["text"] });
});

test("channelOfPath: the channel and the upstream path, null for anything else", () => {
  expect(channelOfPath("/_cgsconnect/c/cgs-codex/v1/responses")).toEqual({ channel: "cgs-codex", rest: "/v1/responses" });
  expect(channelOfPath("/_cgsconnect/c/cgs-claude")).toEqual({ channel: "cgs-claude", rest: "/" });
  expect(channelOfPath("/_cgsconnect/c/other/v1")).toBeNull();
  expect(channelOfPath("/v1/messages")).toBeNull();
});

test("the hub serves only its own origin", async () => {
  const hub = createProviderHub({ router: router() });
  expect((await hub.fetch(new Request("http://elsewhere.example/_cgsconnect/manifest"))).status).toBe(403);
  expect((await hub.fetch(new Request(`${CGSCONNECT_ORIGIN}/_cgsconnect/manifest`))).status).toBe(200);
});

test("extension registers the channels from the live manifest with the client credential and no oauth, through cgsconnect by direct call", async () => {
  const hub = createProviderHub({ router: router(), models: ["claude-a", "gpt-5", "gemini-3-pro"] });
  const reg: Record<string, any> = {};
  await registerChannels({ registerProvider: (n, c) => void (reg[n] = c), registerCommand: () => {} }, (i, init) => hub.fetch(new Request(i, init)));
  expect(Object.keys(reg).sort()).toEqual(["cgs-antigravity", "cgs-claude", "cgs-codex"]);
  expect(reg["cgs-claude"].api).toBe("anthropic-messages");
  expect(reg["cgs-claude"].apiKey).toBe("CGS_CLIENT_SECRET");
  expect(reg["cgs-antigravity"].apiKey).toBe("CGS_ANTIGRAVITY_KEY");
  expect(reg["cgs-claude"].baseUrl).toBe(`${CGSCONNECT_ORIGIN}/_cgsconnect/c/cgs-claude`);
  for (const c of Object.values(reg)) expect(c.oauth).toBeUndefined();
});
