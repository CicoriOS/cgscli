// Account state of the CGS extension: the stored client credential, the model list and prices fetched with it, and the
// environment variables the channels' `apiKey` names. Ported from the legacy plugin/omp-cgs (credentials.json,
// fetchModelIds, fetchPricing). Server calls leave through the cgsconnect router; the channels are registered from the
// provider hub's manifest, so models and prices reach omp the same way for a fresh login and for a restart.
import fs from "node:fs";
import path from "node:path";
import type { SitePrice } from "@cgscli/connect";

/** Environment variables the channels' `apiKey` names; omp resolves them on every request, so a re-login needs no restart. */
export const SECRET_ENV = "CGS_CLIENT_SECRET";
export const ANTIGRAVITY_KEY_ENV = "CGS_ANTIGRAVITY_KEY";
const ANTIGRAVITY_PROJECT = "cgs";

export interface Account {
  baseUrl: string;
  clientSecret: string;
  username?: string;
  tier?: string;
  /** Last model ids / prices the server returned: registered at once on the next start, refreshed in the background. */
  models: string[];
  pricing: Record<string, SitePrice>;
  /** The relay's display currency as last fetched: prices and amounts are in it. */
  currency?: Currency;
}

export const credentialsPath = (agentDir: string) => path.join(agentDir, "cgs", "credentials.json");

export function readAccount(agentDir: string): Account | null {
  let v: unknown;
  try { v = JSON.parse(fs.readFileSync(credentialsPath(agentDir), "utf8")); } catch { return null; }
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.baseUrl !== "string" || !o.baseUrl || typeof o.clientSecret !== "string" || !o.clientSecret) return null;
  const pricing = o.pricing && typeof o.pricing === "object" ? (o.pricing as Record<string, SitePrice>) : {};
  return {
    baseUrl: o.baseUrl.replace(/\/+$/, ""),
    clientSecret: o.clientSecret,
    ...(typeof o.username === "string" ? { username: o.username } : {}),
    ...(typeof o.tier === "string" ? { tier: o.tier } : {}),
    models: Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === "string" && m !== "") : [],
    pricing,
    ...(parseCurrency(o.currency) ? { currency: parseCurrency(o.currency)! } : {}),
  };
}

export function writeAccount(agentDir: string, a: Account): void {
  const file = credentialsPath(agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function applyCredentialEnv(secret: string, env: NodeJS.ProcessEnv = process.env): void {
  env[SECRET_ENV] = secret;
  // omp expects the Antigravity channel's credential as JSON {token, projectId}; the gateway ignores the project.
  env[ANTIGRAVITY_KEY_ENV] = JSON.stringify({ token: secret, projectId: ANTIGRAVITY_PROJECT });
}

/**
 * The currency the relay shows amounts in (its console's display type): `code`, `symbol` (free text on a custom
 * currency, an emoji included) and `prefix`, the text printed before an amount (a custom symbol is followed by a space).
 */
export interface Currency { code: string; symbol: string; prefix: string }

/** Environment variable omp (patch P7) reads for the amount prefix of cgs-* models. */
export const CURRENCY_ENV = "CGS_CURRENCY_PREFIX";

const NAMED_CURRENCIES: Record<string, string> = { CNY: "¥", USD: "$" };

/** `{ code, symbol, prefix }` of a pricing or usage payload; null when the server named no currency. */
export function parseCurrency(v: unknown): Currency | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const code = typeof o.code === "string" ? o.code : typeof o.currency === "string" ? o.currency : "";
  const symbol = (typeof o.symbol === "string" && o.symbol.trim()) || NAMED_CURRENCIES[code] || "";
  if (!code && !symbol) return null;
  const prefix = typeof o.prefix === "string" && o.prefix ? o.prefix : symbol || `${code} `;
  return { code: code || symbol, symbol: symbol || code, prefix };
}

/** omp prints amounts of cgs-* models with this prefix; it is read at display time, so a change needs no restart. */
export function applyCurrencyEnv(currency: Currency | null | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (currency) env[CURRENCY_ENV] = currency.prefix;
}

export type Via = (req: Request) => Promise<Response>;

const headers = (secret: string) => ({ Authorization: `Bearer ${secret}`, Accept: "application/json" });

/** GET <baseUrl>/v1/models -> sorted unique ids. Throws a message fit to show the user. */
export async function fetchModelIds(via: Via, baseUrl: string, secret: string, signal?: AbortSignal): Promise<string[]> {
  let res: Response;
  try {
    res = await via(new Request(`${baseUrl.replace(/\/+$/, "")}/v1/models`, { headers: headers(secret), signal: signal ?? AbortSignal.timeout(20_000) }));
  } catch (e) {
    throw new Error(`Cannot fetch the model list, check the network and retry (${e instanceof Error ? e.message : e})`);
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (res.status !== 200 || !Array.isArray(body?.data)) throw new Error(`Fetching the model list failed (HTTP ${res.status})`);
  const ids = [...new Set(body.data.map((m: { id?: unknown }) => (typeof m?.id === "string" ? m.id.trim() : "")).filter(Boolean))].sort();
  if (ids.length === 0) throw new Error("This account has no models available");
  return ids;
}

export interface Pricing { models: Record<string, SitePrice>; currency: Currency | null }

/**
 * GET <baseUrl>/api/device/pricing -> { model: { input, output, cache_read?, cache_write? } } per million tokens in the
 * relay's display currency (the site's real prices after the group ratio) and that currency. Best effort: null on any
 * failure, models then register unpriced.
 */
export async function fetchPricing(via: Via, baseUrl: string, secret: string, signal?: AbortSignal): Promise<Pricing | null> {
  try {
    const res = await via(new Request(`${baseUrl.replace(/\/+$/, "")}/api/device/pricing`, { headers: headers(secret), signal: signal ?? AbortSignal.timeout(10_000) }));
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: unknown; data?: Record<string, unknown> };
    const d = body?.data;
    if (body?.success !== true || !d || !d.models || typeof d.models !== "object") return null;
    return { models: d.models as Record<string, SitePrice>, currency: parseCurrency(d) };
  } catch { return null; }
}
