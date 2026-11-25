// The /usage card of the CGS account, shaped like the New API wallet page: Current Balance, Total Usage and API Requests
// (web/src/features/wallet/components/wallet-stats-card.tsx), plus the tier and what is left of each subscription, all from
// GET /api/device/usage. Amounts are in the relay's display currency (the one its console shows, see Currency); omp prints
// them with the amount prefix the extension exports (patch P7, unit `currency`). Registered as an omp UsageProvider on the
// login provider, so /usage shows one card for the account.
import { applyCurrencyEnv, type Currency, parseCurrency, type Via } from "./account.ts";

const RESET_LABEL: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", custom: "Custom" };

export interface DeviceUsage {
  tier: string;
  username: string;
  /** The relay's display currency; null when the server names none (an older server). */
  currency: Currency | null;
  /** `usedAmount` / `requestCount` are absent on a server older than the wallet fields; their rows are then left out. */
  balance: { amount: number; usedAmount?: number; requestCount?: number };
  subscriptions: {
    id: number; title: string; total: number; used: number; totalDisplay: string; usedDisplay: string;
    resetPeriod: string; nextResetAt: number; endTime: number;
  }[];
  generatedAt: number;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const optNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Servers before the display-currency fields only reported yuan (`cny`, `used_cny`); read those as yuan. */
const LEGACY_YUAN: Currency = { code: "CNY", symbol: "¥", prefix: "¥" };

/** The `data` object of a usage response, or null when it is not one. */
export function parseDeviceUsage(data: unknown): DeviceUsage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const b = (d.balance && typeof d.balance === "object" ? d.balance : {}) as Record<string, unknown>;
  const modern = optNum(b.amount) !== undefined;
  const amount = modern ? optNum(b.amount)! : num(b.cny);
  const usedAmount = optNum(modern ? b.used_amount : b.used_cny);
  const requestCount = optNum(b.request_count);
  const subs = Array.isArray(d.subscriptions) ? d.subscriptions : [];
  return {
    tier: str(d.tier) || "free",
    username: str(d.username),
    currency: parseCurrency(d.currency) ?? (modern ? null : LEGACY_YUAN),
    balance: { amount, ...(usedAmount !== undefined ? { usedAmount } : {}), ...(requestCount !== undefined ? { requestCount } : {}) },
    subscriptions: subs.filter((s) => s && typeof s === "object").map((raw) => {
      const s = raw as Record<string, unknown>;
      return {
        id: num(s.id), title: str(s.plan_title) || "Subscription", total: Math.max(0, num(s.amount_total)), used: Math.max(0, num(s.amount_used)),
        totalDisplay: str(s.amount_total_display), usedDisplay: str(s.amount_used_display),
        resetPeriod: str(s.reset_period) || "never", nextResetAt: num(s.next_reset_at), endTime: num(s.end_time),
      };
    }),
    generatedAt: num(d.generated_at),
  };
}

export async function fetchDeviceUsage(via: Via, baseUrl: string, secret: string, signal?: AbortSignal): Promise<DeviceUsage | null> {
  try {
    const res = await via(new Request(`${baseUrl.replace(/\/+$/, "")}/api/device/usage`, {
      headers: { authorization: `Bearer ${secret}`, accept: "application/json" }, signal: signal ?? AbortSignal.timeout(10_000),
    }));
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: unknown; data?: unknown };
    return body?.success === true ? parseDeviceUsage(body.data) : null;
  } catch { return null; }
}

// Minimal structural copies of omp's UsageReport (ai/src/usage.ts); the extension must not import omp internals.
// `currency` is the unit patch P7 adds to omp (patches/0004).
export interface CgsUsageLimit {
  id: string; label: string; scope: { provider: string; tier?: string };
  window?: { id: string; label: string; resetsAt?: number };
  amount: { used?: number; limit?: number; remaining?: number; usedFraction?: number; remainingFraction?: number; unit: "credits" | "currency" | "requests" };
  status?: "ok" | "warning" | "exhausted" | "unknown"; notes?: string[];
}
export interface CgsUsageReport { provider: string; fetchedAt: number; limits: CgsUsageLimit[]; notes?: string[]; metadata?: Record<string, unknown> }

/** A subscription with a total counts as exhausted at 100% and warns from 90%; total 0 means no cap. */
export function buildUsageReport(provider: string, u: DeviceUsage, now = Date.now()): CgsUsageReport {
  const scope = { provider, tier: u.tier };
  const limits: CgsUsageLimit[] = [{
    id: "balance", label: "Current Balance", scope, notes: ["Remaining quota"],
    amount: { remaining: u.balance.amount, unit: "currency" }, status: u.balance.amount > 0 ? "ok" : "exhausted",
  }];
  if (u.balance.usedAmount !== undefined) {
    limits.push({ id: "total-usage", label: "Total Usage", scope, notes: ["Total consumed quota"], amount: { used: u.balance.usedAmount, unit: "currency" }, status: "ok" });
  }
  if (u.balance.requestCount !== undefined) {
    limits.push({ id: "api-requests", label: "API Requests", scope, notes: ["Total requests made"], amount: { used: u.balance.requestCount, unit: "requests" }, status: "ok" });
  }
  for (const s of u.subscriptions) {
    const capped = s.total > 0;
    const fraction = capped ? Math.min(1, s.used / s.total) : undefined;
    const period = RESET_LABEL[s.resetPeriod];
    limits.push({
      id: `sub-${s.id}`, label: s.title, scope,
      ...(period && s.nextResetAt > 0 ? { window: { id: s.resetPeriod, label: period, resetsAt: s.nextResetAt * 1000 } } : {}),
      amount: capped ? { used: s.used, limit: s.total, usedFraction: fraction, remainingFraction: 1 - fraction!, unit: "credits" } : { used: s.used, unit: "credits" },
      status: fraction === undefined ? "ok" : fraction >= 1 ? "exhausted" : fraction >= 0.9 ? "warning" : "ok",
      notes: [capped ? `${s.usedDisplay || s.used} / ${s.totalDisplay || s.total}` : `${s.usedDisplay || s.used} used · Unlimited`],
    });
  }
  return {
    provider, fetchedAt: u.generatedAt > 0 ? u.generatedAt * 1000 : now, limits,
    notes: [`Account ${u.username || "-"} · Tier ${u.tier}`],
    metadata: { currency: u.currency?.code ?? null, balance: u.balance.amount },
  };
}

export interface UsageProviderLike {
  id: string;
  fetchUsage(params: { signal?: AbortSignal }, ctx?: unknown): Promise<CgsUsageReport | null>;
}

/** The account is read at call time, so a re-login or sign-out needs no re-registration. */
export function createUsageProvider(provider: string, via: Via, account: () => { baseUrl: string; clientSecret: string } | null): UsageProviderLike {
  return {
    id: provider,
    async fetchUsage(params) {
      const a = account();
      if (!a) return null;
      const u = await fetchDeviceUsage(via, a.baseUrl, a.clientSecret, params.signal);
      if (!u) return null;
      // The amounts of this report are in the relay's currency; keep omp's prefix for them in step with it.
      applyCurrencyEnv(u.currency);
      return buildUsageReport(provider, u);
    },
  };
}
