import { expect, test } from "bun:test";
import { buildUsageReport, createUsageProvider, fetchDeviceUsage, parseDeviceUsage } from "../usage.ts";

const body = (data: unknown) => Response.json({ success: true, data });
const balance = { quota: 500000, used_quota: 1000, request_count: 1234, cny: 12.34, cny_display: "¥12.34", used_cny: 3.5, used_cny_display: "¥3.5" };
const wallet = { tier: "lite", username: "ann", balance, subscriptions: [], generated_at: 1_700_000_000 };

test("the card carries the wallet page's three figures, in yuan, in the wallet's order", () => {
  const r = buildUsageReport("cgs", parseDeviceUsage(wallet)!);
  expect(r.limits.map((l) => l.label)).toEqual(["Current Balance", "Total Usage", "API Requests"]);
  expect(r.limits[0]).toMatchObject({ id: "balance", status: "ok", amount: { remaining: 12.34, unit: "cny" }, notes: ["Remaining quota"] });
  expect(r.limits[1]).toMatchObject({ amount: { used: 3.5, unit: "cny" }, notes: ["Total consumed quota"] });
  expect(r.limits[2]).toMatchObject({ amount: { used: 1234, unit: "requests" }, notes: ["Total requests made"] });
  expect(r.notes).toEqual(["Account ann · Tier lite"]);
  expect(r.fetchedAt).toBe(1_700_000_000_000);
});

test("a server without the wallet fields still gives the balance, and no invented zeros", () => {
  const { used_cny, used_cny_display, request_count, ...old } = balance;
  const r = buildUsageReport("cgs", parseDeviceUsage({ ...wallet, balance: old })!);
  expect(r.limits.map((l) => l.label)).toEqual(["Current Balance"]);
});

test("zero consumption and zero requests are real values and stay on the card", () => {
  const r = buildUsageReport("cgs", parseDeviceUsage({ ...wallet, balance: { ...balance, used_cny: 0, request_count: 0 } })!);
  expect(r.limits.map((l) => l.label)).toEqual(["Current Balance", "Total Usage", "API Requests"]);
  expect(r.limits[1]!.amount.used).toBe(0);
});

test("an empty wallet is exhausted", () => {
  const r = buildUsageReport("cgs", parseDeviceUsage({ ...wallet, balance: { ...balance, cny: 0, cny_display: "¥0.00" } })!);
  expect(r.limits[0]!.status).toBe("exhausted");
});

test("subscriptions: fraction, status thresholds, reset window, uncapped plans", () => {
  const sub = (o: object) => ({ id: 1, plan_title: "Pro", amount_total: 100, amount_used: 25, amount_total_display: "¥100", amount_used_display: "¥25", reset_period: "monthly", next_reset_at: 1_800_000_000, ...o });
  const r = buildUsageReport("cgs", parseDeviceUsage({ ...wallet, subscriptions: [sub({}), sub({ id: 2, amount_used: 95 }), sub({ id: 3, amount_used: 100 }), sub({ id: 4, amount_total: 0, amount_total_display: "", amount_used_display: "¥7", reset_period: "never" })] })!);
  const by = (id: string) => r.limits.find((l) => l.id === id)!;
  expect(by("sub-1")).toMatchObject({ label: "Pro", status: "ok", notes: ["¥25 / ¥100"], window: { label: "Monthly", resetsAt: 1_800_000_000_000 } });
  expect(by("sub-1").amount).toMatchObject({ usedFraction: 0.25, remainingFraction: 0.75 });
  expect(by("sub-2").status).toBe("warning");
  expect(by("sub-3").status).toBe("exhausted");
  expect(by("sub-4")).toMatchObject({ status: "ok", notes: ["¥7 used · Unlimited"] });
  expect(by("sub-4").amount.limit).toBeUndefined();
  expect(by("sub-4").window).toBeUndefined();
});

test("a failed or malformed response is no report, never a throw", async () => {
  expect(await fetchDeviceUsage(async () => new Response("x", { status: 500 }), "http://s", "k")).toBeNull();
  expect(await fetchDeviceUsage(async () => Response.json({ success: false }), "http://s", "k")).toBeNull();
  expect(await fetchDeviceUsage(async () => { throw new Error("down"); }, "http://s", "k")).toBeNull();
});

test("the provider reads the account when asked: signed out gives nothing, a new login is picked up", async () => {
  let acct: { baseUrl: string; clientSecret: string } | null = null;
  const seen: string[] = [];
  const p = createUsageProvider("cgs", async (r) => { seen.push(`${r.url} ${r.headers.get("authorization")}`); return body(wallet); }, () => acct);
  expect(await p.fetchUsage({})).toBeNull();
  expect(seen).toEqual([]);
  acct = { baseUrl: "http://s/", clientSecret: "k1" };
  expect((await p.fetchUsage({}))!.provider).toBe("cgs");
  expect(seen).toEqual(["http://s/api/device/usage Bearer k1"]);
});
