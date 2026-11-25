import { displayName } from "./display-name.ts";
// Channel classification, model manifest and the channel path prefix (docs: cgsconnect/providers.md, ADR 0021, ADR 0022).
import type { ModelEntry, ModelManifest } from "../contracts.ts";

export const CHANNELS = ["cgs-claude", "cgs-antigravity", "cgs-codex", "cgs-openai"] as const;
export type Channel = (typeof CHANNELS)[number];

/** omp transport per channel and the path suffix appended to the local endpoint (legacy plugin/omp-cgs/index.js). */
export const CHANNEL_API: Record<Channel, { api: string; pathSuffix: string }> = {
  "cgs-claude": { api: "anthropic-messages", pathSuffix: "" },
  "cgs-antigravity": { api: "google-gemini-cli", pathSuffix: "" },
  "cgs-codex": { api: "openai-codex-responses", pathSuffix: "/v1" },
  "cgs-openai": { api: "openai-completions", pathSuffix: "/v1" },
};

const CODEX_ID = /^(gpt|o\d|codex|chatgpt)|astra/i;
const NON_CHAT_ID = /(^|[-_./])(image|images|imagen|dall-?e|embedding|embeddings|embed|whisper|tts|transcribe|moderation|rerank|sora|veo|video)([-_./\d]|$)/i;

export function channelForModel(id: string): Channel | null {
  if (NON_CHAT_ID.test(id)) return null;
  if (/^claude/i.test(id)) return "cgs-claude";
  if (/^gemini/i.test(id)) return "cgs-antigravity";
  if (CODEX_ID.test(id)) return "cgs-codex";
  return "cgs-openai";
}

interface Family { test: RegExp; reasoning: boolean; contextWindow: number; maxTokens: number }
const FAMILIES: Family[] = [
  { test: /^claude/i, reasoning: true, contextWindow: 200000, maxTokens: 32000 },
  { test: /^gemini/i, reasoning: true, contextWindow: 1048576, maxTokens: 65536 },
  { test: /^deepseek/i, reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { test: /^(glm|grok|kimi|minimax)/i, reasoning: true, contextWindow: 131072, maxTokens: 8192 },
];
const FALLBACK: Omit<Family, "test"> = { reasoning: false, contextWindow: 128000, maxTokens: 16384 };

export interface SitePrice { input: number; output: number; cache_read?: number; cache_write?: number }

/** Site price (CNY per million tokens) -> manifest price; per-call models stay unpriced. */
export function manifestPrice(p: SitePrice | undefined): ModelEntry["price"] | undefined {
  if (!p || typeof p.input !== "number" || typeof p.output !== "number") return undefined;
  return { input: p.input, output: p.output, cacheRead: Number(p.cache_read) || 0, cacheWrite: Number(p.cache_write) || 0 };
}

/** Manifest the extension registers from. `localBase` is the local endpoint (with its session token path). */
export function buildManifest(localBase: string, modelIds: string[], pricing: Record<string, SitePrice> = {}): ModelManifest {
  const by = new Map<Channel, ModelEntry[]>();
  for (const id of new Set(modelIds.map((m) => m.trim()).filter(Boolean))) {
    const ch = channelForModel(id);
    if (!ch) continue;
    const f = FAMILIES.find((x) => x.test.test(id)) ?? FALLBACK;
    const price = manifestPrice(pricing[id]);
    const list = by.get(ch) ?? [];
    list.push({ id, name: displayName(id), contextWindow: f.contextWindow, maxTokens: f.maxTokens, reasoning: f.reasoning, ...(price ? { price } : {}) });
    by.set(ch, list);
  }
  return {
    providers: CHANNELS.filter((c) => by.has(c)).map((c) => ({ id: c, channel: c, baseUrl: `${localBase}${CHANNEL_PREFIX}${c}${CHANNEL_API[c].pathSuffix}`, models: by.get(c)! })),
  };
}

// ---- which channel a request is for ----------------------------------------------------------------------------

/** Path prefix of a channel's `baseUrl` on the local origin. The hub reads the channel from it and forwards without it. */
export const CHANNEL_PREFIX = "/_cgsconnect/c/";

/** The channel and the upstream path of a request path under a channel prefix; null for any other path. */
export function channelOfPath(pathname: string): { channel: Channel; rest: string } | null {
  if (!pathname.startsWith(CHANNEL_PREFIX)) return null;
  const tail = pathname.slice(CHANNEL_PREFIX.length);
  const slash = tail.indexOf("/");
  const name = slash < 0 ? tail : tail.slice(0, slash);
  const channel = CHANNELS.find((c) => c === name);
  return channel ? { channel, rest: slash < 0 ? "/" : tail.slice(slash) } : null;
}
