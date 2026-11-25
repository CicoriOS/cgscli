import { displayName } from "./display-name.ts";
// Channel classification, slot credential shapes and rotation-notice detection (docs: cgsconnect/providers.md, ADR 0005).
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
    providers: CHANNELS.filter((c) => by.has(c)).map((c) => ({ id: c, channel: c, baseUrl: `${localBase}${CHANNEL_API[c].pathSuffix}`, models: by.get(c)! })),
  };
}

// ---- slot credential shapes (gateway-issued) -------------------------------------------------------------------

export interface Slot { provider: Channel; id: string; key: string }

function jwtClaims(key: string): Record<string, unknown> | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1]!, "base64url").toString()); } catch { return null; }
}

/** Returns an error message, or null when the key has the shape omp's subscription handling needs. */
export function slotShapeError(provider: Channel, key: string): string | null {
  if (provider === "cgs-claude") return key.includes("sk-ant-oat") ? null : "Claude key must contain sk-ant-oat";
  if (provider === "cgs-codex") {
    const claims = jwtClaims(key);
    const auth = claims?.["https://api.openai.com/auth"];
    const acct = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
    return typeof acct === "string" && acct ? null : "Codex key must be a JWT with chatgpt_account_id";
  }
  if (provider === "cgs-antigravity") {
    try {
      const j: unknown = JSON.parse(key);
      const o = j && typeof j === "object" ? (j as Record<string, unknown>) : {};
      return typeof o.token === "string" && o.token && typeof o.projectId === "string" && o.projectId ? null : "Antigravity key needs token and projectId";
    } catch { return "Antigravity key must be a JSON envelope"; }
  }
  return null;
}

/** The secret a request carries for a slot (Antigravity sends the envelope's token). */
export function slotSecret(s: Slot): string {
  if (s.provider !== "cgs-antigravity") return s.key;
  const j: unknown = JSON.parse(s.key);
  return String((j as Record<string, unknown>).token);
}

// ---- rotation notices ------------------------------------------------------------------------------------------

/**
 * Whether an upstream error response is a quota-exhausted notice that makes omp rotate (and not a rolling rate limit,
 * which does not). Pure; applied by the proxy to non-success responses. Wording follows providers.md and omp's
 * error/rate-limit.ts classification at @76b7d84.
 */
export function isRotationNotice(provider: Channel, status: number, body: string): boolean {
  const b = body.toLowerCase();
  if (provider === "cgs-codex") return status === 429 && b.includes("usage_limit_reached");
  if (provider === "cgs-antigravity") return status === 429 && b.includes("quota_exhausted");
  if (provider === "cgs-claude") return (status === 429 || status === 402) && (b.includes("usage limit reached") || b.includes("insufficient quota"));
  return false;
}
