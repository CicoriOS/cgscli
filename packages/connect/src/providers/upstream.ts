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
  };
}

/**
 * NewAPI gave up on the account that served a request (`rotate=1`) and the request failed. Answer with the provider's
 * own transient error instead, so omp's ordinary retry sends it again, now under the new session identity
 * (ADR 0022). Deliberately not a usage limit: omp would block its only credential. A success is never touched.
 */
export function transientFailure(provider: Channel, status: number, original: string, u: Upstream): { status: number; body: string } | null {
  if (!u.rotate || status < 400) return null;
  const detail = `${original.slice(0, 300)} (CGS: ${u.reason}, upstream status ${status})`;
  switch (provider) {
    case "cgs-claude":
      return { status: 529, body: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: `Overloaded: ${detail}` } }) };
    case "cgs-antigravity":
      return { status: 503, body: JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: `The service is currently unavailable: ${detail}` } }) };
    default:
      return { status: 503, body: JSON.stringify({ error: { type: "server_error", code: "server_error", message: `The server had an error: ${detail}` } }) };
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
