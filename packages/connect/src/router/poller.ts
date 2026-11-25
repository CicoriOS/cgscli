// Periodic account polling moved from the Electron main process (legacy src/cgs/controller.js, tier.js, usage.js, tunnel.js).
// Requests go through the Router, so they take the relay when direct is down. Credentials are supplied by the caller.
import type { Router } from "../contracts.ts";

export const TIER_INTERVAL_MS = 30 * 60_000;
export const USAGE_INTERVAL_MS = 5 * 60_000;

export interface DeviceCredentials { baseUrl: string; clientSecret: string }
export interface ClientInfo { os: string; version: string }

export interface Subscription {
  id: number; planId: number; planTitle: string; amountTotal: number; amountUsed: number; totalDisplay: string; usedDisplay: string;
  unlimited: boolean; resetPeriod: string; nextResetAt: number; startTime: number; endTime: number;
  dailyTokenLimits: { model: string; limit: number; used: number; resetAt: number }[];
}
export interface Usage {
  tier: string | null; username: string | null;
  balance: { quota: number; usedQuota: number; display: string };
  subscriptions: Subscription[]; generatedAt: number;
}

export interface PollerEvents {
  onTier?(t: { tier: string; username: string | null }): void;
  /** Server default layout (/api/device/layout), raw `data`; fetched on the first successful tier check after login only. */
  onLayout?(layout: unknown): void;
  onUsage?(u: { usage: Usage | null; stale: boolean; fetchedAt: number }): void;
  /** Server answered 401: the credential is revoked; polling stops until `login()`. */
  onLoggedOut?(): void;
}

export interface PollerOptions extends PollerEvents {
  router: Router;
  credentials(): DeviceCredentials | null;
  client: ClientInfo;
  tierIntervalMs?: number;
  usageIntervalMs?: number;
}

export type Outcome = "ok" | "unauthorized" | "error" | "signed-out";

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const PERIODS = ["never", "daily", "weekly", "monthly", "custom"];

export function normalizeUsage(data: unknown): Usage | null {
  if (!data || typeof data !== "object") return null;
  const d = obj(data), b = obj(d.balance);
  return {
    tier: str(d.tier) || null, username: str(d.username) || null,
    balance: { quota: num(b.quota), usedQuota: num(b.used_quota), display: str(b.cny_display) || str(b.display) },
    generatedAt: num(d.generated_at),
    subscriptions: list(d.subscriptions).map((raw) => {
      const s = obj(raw);
      const total = Math.max(0, num(s.amount_total));
      return {
        id: num(s.id), planId: num(s.plan_id), planTitle: str(s.plan_title), amountTotal: total, amountUsed: Math.max(0, num(s.amount_used)),
        totalDisplay: str(s.amount_total_display), usedDisplay: str(s.amount_used_display), unlimited: total === 0,
        resetPeriod: PERIODS.includes(str(s.reset_period)) ? str(s.reset_period) : "never",
        nextResetAt: num(s.next_reset_at), startTime: num(s.start_time), endTime: num(s.end_time),
        dailyTokenLimits: list(s.daily_token_limits).map(obj).filter((l) => str(l.model)).map((l) => ({ model: str(l.model), limit: Math.max(0, num(l.limit)), used: Math.max(0, num(l.used)), resetAt: num(l.reset_at) })),
      };
    }),
  };
}

export class Poller {
  private tierTimer: ReturnType<typeof setInterval> | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private revoked = false;
  private layoutApplied = false;
  private usage: Usage | null = null;
  private stale = false;
  private fetchedAt = 0;
  private tierInflight: Promise<Outcome> | null = null;
  private usageInflight: Promise<Outcome> | null = null;

  constructor(private o: PollerOptions) {}

  start(): Promise<Outcome> {
    this.schedule();
    void this.refreshUsage();
    return this.refreshTier();
  }

  stop() {
    clearInterval(this.tierTimer ?? undefined); this.tierTimer = null;
    clearInterval(this.usageTimer ?? undefined); this.usageTimer = null;
  }

  /** A fresh login: trust the credential again. */
  login(): Promise<Outcome> {
    this.revoked = false; this.layoutApplied = false; this.usage = null; this.stale = false;
    this.schedule();
    void this.refreshUsage();
    return this.refreshTier();
  }

  private schedule() {
    if (this.revoked) return;
    this.tierTimer ??= setInterval(() => void this.refreshTier(), this.o.tierIntervalMs ?? TIER_INTERVAL_MS);
    this.usageTimer ??= setInterval(() => void this.refreshUsage(), this.o.usageIntervalMs ?? USAGE_INTERVAL_MS);
    this.tierTimer.unref?.(); this.usageTimer.unref?.();
  }

  private markRevoked() {
    this.revoked = true; this.usage = null; this.stale = false;
    this.stop();
    this.o.onUsage?.({ usage: null, stale: false, fetchedAt: this.fetchedAt });
    this.o.onLoggedOut?.();
  }

  private async get(c: DeviceCredentials, p: string): Promise<{ status: number; data: unknown } | null> {
    try {
      const r = await this.o.router.fetch(new Request(`${c.baseUrl.replace(/\/+$/, "")}${p}`, {
        headers: { Authorization: `Bearer ${c.clientSecret}`, "X-Client-OS": this.o.client.os.slice(0, 64), "X-Client-Version": this.o.client.version.slice(0, 32) },
        signal: AbortSignal.timeout(15_000),
      }));
      const body: unknown = await r.json().catch(() => null);
      return { status: r.status, data: obj(body).success === true ? obj(body).data : null };
    } catch { return null; }
  }

  refreshTier(): Promise<Outcome> {
    this.tierInflight ??= this.runTier().finally(() => { this.tierInflight = null; });
    return this.tierInflight;
  }

  private async runTier(): Promise<Outcome> {
    const c = this.o.credentials();
    if (!c) return "signed-out";
    const res = await this.get(c, "/api/device/tier");
    if (!res) return "error";
    if (res.status === 401) { this.markRevoked(); return "unauthorized"; }
    const d = obj(res.data);
    if (res.status !== 200 || !str(d.tier)) return "error";
    this.revoked = false;
    this.o.onTier?.({ tier: str(d.tier), username: str(d.username) || null });
    // The server's tunnel bundle goes to the router as is; the router verifies it against its roots.
    const t = await this.get(c, "/api/device/tunnel");
    if (t && t.status === 200) {
      const td = obj(t.data);
      try { if (td.enabled && td.bundle) this.o.router.setTunnel(td.bundle); else this.o.router.clearTunnel(); } catch { /* unverifiable bundle: keep the old one */ }
    }
    if (!this.layoutApplied) {
      const l = await this.get(c, "/api/device/layout");
      if (l && l.status === 200 && l.data) { this.layoutApplied = true; this.o.onLayout?.(l.data); }
    }
    return "ok";
  }

  refreshUsage(): Promise<Outcome> {
    this.usageInflight ??= this.runUsage().finally(() => { this.usageInflight = null; });
    return this.usageInflight;
  }

  private async runUsage(): Promise<Outcome> {
    if (this.revoked) return "unauthorized";
    const c = this.o.credentials();
    if (!c) return "signed-out";
    const res = await this.get(c, "/api/device/usage");
    if (res?.status === 401) { this.markRevoked(); return "unauthorized"; }
    const usage = res && res.status === 200 ? normalizeUsage(res.data) : null;
    if (usage) { this.usage = usage; this.stale = false; this.fetchedAt = Date.now(); }
    else if (this.usage) this.stale = true;
    this.o.onUsage?.({ usage: this.usage, stale: this.stale, fetchedAt: this.fetchedAt });
    return usage ? "ok" : "error";
  }
}
