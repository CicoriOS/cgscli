// X-CGS-Upstream: what NewAPI reports about the channel that served a response (parsed here, produced in NewAPI's
// service/cgs_upstream.go). The client only OBSERVES: it never names, prefers or pins a channel, and the channel id is
// display/event data. Everything here is additive: omp's own rotation and identity code is not touched.
import type { Channel } from "./channels.ts";

export const UPSTREAM_HEADER = "x-cgs-upstream";

export interface Upstream {
  family: string;
  persona: string;
  channel?: number;
  from?: number;
  switched: boolean;
  limited: boolean;
  rotate: boolean;
  refresh: boolean;
  reason: string;
  retryAfterSec?: number;
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || !/^\d{1,9}$/.test(v)) return undefined;
  return Number(v);
};

/** Tolerant: unknown keys, junk values and a missing/unknown version all yield null or ignore the key. */
export function parseUpstream(h: string | null): Upstream | null {
  if (!h) return null;
  const kv = new Map<string, string>();
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  if (kv.get("v") !== "1") return null;
  const flag = (k: string) => kv.get(k) === "1";
  return {
    family: kv.get("family") ?? "other",
    persona: kv.get("persona") ?? "none",
    channel: num(kv.get("channel")),
    from: num(kv.get("from")),
    switched: flag("switched"),
    limited: flag("limited"),
    rotate: flag("rotate"),
    refresh: flag("refresh"),
    reason: kv.get("reason") ?? "none",
    retryAfterSec: num(kv.get("retry-after")),
  };
}

/** Default cooldown when NewAPI says the account is exhausted but gives no time. */
export const DEFAULT_COOLDOWN_SEC = 30 * 60;

/**
 * NewAPI gave up on an exhausted account (`rotate=1`) with a status omp would not treat as a usage limit (503, 5xx,
 * 401 from an empty pool...). Rewrite it into the usage-limit answer of the provider's own wire format, so omp's own
 * rotation runs: next credential slot, new account identity (`device_id`), fresh session id. 429/402 already rotate.
 * Only the failure is rewritten; a 2xx is never touched (it cannot make omp refresh, which is stated in the docs).
 */
export function usageLimitRewrite(provider: Channel, status: number, original: string, u: Upstream): { status: number; body: string } | null {
  if (!u.rotate || status < 400 || status === 429 || status === 402) return null;
  const detail = `${original.slice(0, 300)} (CGS: ${u.reason}, upstream status ${status})`;
  switch (provider) {
    case "cgs-claude":
      return { status: 429, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `Usage limit reached: ${detail}` } }) };
    case "cgs-codex":
      return { status: 429, body: JSON.stringify({ error: { type: "usage_limit_reached", message: `The usage limit has been reached: ${detail}` } }) };
    case "cgs-antigravity":
      return { status: 429, body: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `QUOTA_EXHAUSTED: ${detail}` } }) };
    default:
      return { status: 429, body: JSON.stringify({ error: { type: "usage_limit_reached", code: "usage_limit_reached", message: `Usage limit reached: ${detail}` } }) };
  }
}

export interface ChannelObserved { provider: Channel; from: number | null; to: number }
export interface ChannelRefreshed { provider: Channel; channel: number }

/** Per-provider memory of the last channel NewAPI reported, so a change can be announced. Read-only for the UI. */
export class ChannelTracker {
  private last = new Map<Channel, number>();
  lastChannel(p: Channel): number | undefined { return this.last.get(p); }
  /** Returns the change to announce, if any. `from` from NewAPI wins over our own memory. */
  observe(p: Channel, u: Upstream): ChannelObserved | null {
    if (u.channel === undefined) return null;
    const prev = this.last.get(p);
    this.last.set(p, u.channel);
    const from = u.switched && u.from !== undefined ? u.from : prev ?? null;
    return from !== null && from !== u.channel ? { provider: p, from, to: u.channel } : null;
  }
}

/**
 * A new session identity for the next request of `provider` (Claude Code's `/new`): a fresh session id, with the
 * account-bound `device_id` / `account_uuid` kept as omp derived them (see omp's rebindAnthropicMetadataUserId).
 */
export function refreshSession(provider: Channel, headers: Headers, body: string | null, id: () => string = () => crypto.randomUUID()): string | null {
  if (provider !== "cgs-claude") return body;
  const fresh = id();
  if (headers.has("x-claude-code-session-id")) headers.set("x-claude-code-session-id", fresh);
  if (body === null) return body;
  let j: unknown;
  try { j = JSON.parse(body); } catch { return body; }
  if (!j || typeof j !== "object") return body;
  const meta = (j as Record<string, unknown>).metadata;
  const uid = meta && typeof meta === "object" ? (meta as Record<string, unknown>).user_id : undefined;
  if (typeof uid !== "string") return body;
  let parsed: unknown;
  try { parsed = JSON.parse(uid); } catch { return body; } // opaque ids are a real client's own: leave them
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).session_id !== "string") return body;
  (parsed as Record<string, unknown>).session_id = fresh;
  (meta as Record<string, unknown>).user_id = JSON.stringify(parsed);
  return JSON.stringify(j);
}
