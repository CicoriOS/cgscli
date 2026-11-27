// Account state of the CGS extension: the stored client credential and the model list, prices and capabilities fetched
// with it. Server calls leave through the cgsconnect router; the provider hub's manifest feeds omp on login and restart.
import fs from "node:fs";
import path from "node:path";
import type { InputModality, ModelCapabilities, SitePrice } from "@cgscli/connect";

/** Environment variables the channels' `apiKey` names; omp resolves them on every request, so a re-login needs no restart. */
export const SECRET_ENV = "CGS_CLIENT_SECRET";
export const ANTIGRAVITY_KEY_ENV = "CGS_ANTIGRAVITY_KEY";
const ANTIGRAVITY_PROJECT = "cgs";

export interface Account {
  baseUrl: string;
  clientSecret: string;
  username?: string;
  tier?: string;
  /** Last model ids, prices and capabilities the server returned: registered at once on restart. */
  models: string[];
  pricing: Record<string, SitePrice>;
  capabilities: ModelCapabilities;
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
    capabilities: parseModelCapabilities(o.capabilities) ?? {},
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

const INPUT_MODALITIES: Record<InputModality, true> = { text: true, image: true, audio: true, video: true, pdf: true };
const THINKING_LEVELS: Record<string, true> = { minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };

function parseModelCapabilities(value: unknown): ModelCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const models: ModelCapabilities = Object.create(null);
  for (const [id, entry] of Object.entries(value)) {
    if (!id.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { input, thinking_levels, source, context_window, max_output_tokens, reasoning } = entry as Record<string, unknown>;
    if (!Array.isArray(input)) continue;
    const modalities = new Set<InputModality>(["text"]);
    for (const modality of input) {
      if (typeof modality === "string" && Object.hasOwn(INPUT_MODALITIES, modality)) modalities.add(modality as InputModality);
    }
    const levels = Array.isArray(thinking_levels) ? thinking_levels.filter((level): level is string => typeof level === "string" && Object.hasOwn(THINKING_LEVELS, level)) : [];
    models[id] = {
      input: [...modalities],
      ...(levels.length ? { thinking_levels: levels } : {}),
      ...(typeof source === "string" ? { source } : {}),
      ...(typeof context_window === "number" && Number.isSafeInteger(context_window) && context_window > 0 ? { context_window } : {}),
      ...(typeof max_output_tokens === "number" && Number.isSafeInteger(max_output_tokens) && max_output_tokens > 0 ? { max_output_tokens } : {}),
      ...(typeof reasoning === "boolean" ? { reasoning } : {}),
    };
  }
  return models;
}

/** GET <baseUrl>/api/device/models. Best effort: null on failure, including on servers without the endpoint. */
export async function fetchModelCapabilities(via: Via, baseUrl: string, secret: string, signal?: AbortSignal): Promise<ModelCapabilities | null> {
  try {
    const res = await via(new Request(`${baseUrl.replace(/\/+$/, "")}/api/device/models`, { headers: headers(secret), signal: signal ?? AbortSignal.timeout(10_000) }));
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: unknown; data?: { models?: unknown } } | null;
    return body?.success === true ? parseModelCapabilities(body.data?.models) : null;
  } catch { return null; }
}
