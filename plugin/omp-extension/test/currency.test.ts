import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCurrencyEnv, CURRENCY_ENV, fetchPricing, parseCurrency, readAccount, writeAccount } from "../account.ts";

const pricingBody = (data: object) => async () => Response.json({ success: true, data });
const models = { "claude-haiku-5-5": { input: 1.2, output: 6 } };

afterEach(() => {
  delete process.env[CURRENCY_ENV];
});

test("the relay's currency is read as its console shows it: yuan, dollars, a custom symbol with its space", () => {
  expect(parseCurrency({ code: "CNY", symbol: "¥", prefix: "¥" })).toEqual({ code: "CNY", symbol: "¥", prefix: "¥" });
  expect(parseCurrency({ code: "USD", symbol: "$", prefix: "$" })).toEqual({ code: "USD", symbol: "$", prefix: "$" });
  expect(parseCurrency({ code: "CUSTOM", symbol: "🐱", prefix: "🐱 " })).toEqual({ code: "CUSTOM", symbol: "🐱", prefix: "🐱 " });
  expect(parseCurrency({ code: "CUSTOM", symbol: "HK$", prefix: "HK$ " })!.prefix).toBe("HK$ ");
});

test("a server that sends only a currency code: yuan and dollars are named, anything else is shown by its code", () => {
  expect(parseCurrency({ currency: "CNY" })).toEqual({ code: "CNY", symbol: "¥", prefix: "¥" });
  expect(parseCurrency({ currency: "USD" })).toEqual({ code: "USD", symbol: "$", prefix: "$" });
  expect(parseCurrency({ currency: "EUR" })).toEqual({ code: "EUR", symbol: "EUR", prefix: "EUR " });
  expect(parseCurrency({})).toBeNull();
  expect(parseCurrency(null)).toBeNull();
});

test("pricing follows the relay's currency, whatever it is", async () => {
  const cat = { code: "CUSTOM", symbol: "🐱", prefix: "🐱 " };
  const p = await fetchPricing(pricingBody({ currency: "CUSTOM", symbol: "🐱", prefix: "🐱 ", unit: "per_million_tokens", models }), "http://s", "k");
  expect(p).toEqual({ models, currency: cat });
  const old = await fetchPricing(pricingBody({ currency: "CNY", unit: "per_million_tokens", models }), "http://s", "k");
  expect(old!.currency).toEqual({ code: "CNY", symbol: "¥", prefix: "¥" });
  expect(await fetchPricing(async () => new Response("x", { status: 500 }), "http://s", "k")).toBeNull();
});

test("omp is told the prefix, and only when the relay named a currency", () => {
  const env: NodeJS.ProcessEnv = {};
  applyCurrencyEnv(null, env);
  expect(env[CURRENCY_ENV]).toBeUndefined();
  applyCurrencyEnv({ code: "CUSTOM", symbol: "🐱", prefix: "🐱 " }, env);
  expect(env[CURRENCY_ENV]).toBe("🐱 ");
});

test("the stored account keeps the currency, so the first screen after a restart already uses it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-cur-"));
  writeAccount(dir, { baseUrl: "http://s", clientSecret: "k", models: [], pricing: {}, currency: { code: "CUSTOM", symbol: "🐱", prefix: "🐱 " } });
  expect(readAccount(dir)!.currency).toEqual({ code: "CUSTOM", symbol: "🐱", prefix: "🐱 " });
  writeAccount(dir, { baseUrl: "http://s", clientSecret: "k", models: [], pricing: {} });
  expect(readAccount(dir)!.currency).toBeUndefined();
  fs.rmSync(dir, { recursive: true, force: true });
});
