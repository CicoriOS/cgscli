import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../../src/router/index.ts";
import { BUILTIN_RANGES, inRanges, loadRanges, preferIps, sampleIps, validCidr } from "../../src/router/cloudflare.ts";

const v4 = BUILTIN_RANGES.filter((c) => !c.includes(":"));
const v6 = BUILTIN_RANGES.filter((c) => c.includes(":"));
const n4 = (s: string) => s.split(".").reduce((a, p) => a * 256n + BigInt(p), 0n);
const in4 = (ip: string, cidr: string) => { const [b, bits] = cidr.split("/"); const w = 32n - BigInt(bits!); return n4(ip) >> w === n4(b!) >> w; };
const hi16 = (ip: string) => Number.parseInt(ip.split(":")[0]!, 16);

test("sampled IPv4 addresses are distinct and lie inside the ranges", () => {
  const ips = sampleIps(v4, 40);
  expect(new Set(ips).size).toBe(40);
  for (const ip of ips) expect(v4.some((c) => in4(ip, c))).toBe(true);
});

test("sampled IPv6 addresses are valid, distinct and lie inside Cloudflare's IPv6 prefixes", () => {
  const prefixes = ["2400:cb00", "2606:4700", "2803:f800", "2405:b500", "2405:8100", "2c0f:f248"];
  const ips = sampleIps(v6, 30);
  expect(new Set(ips).size).toBe(30);
  for (const ip of ips) {
    expect(Bun.isIPv6?.(ip) ?? ip.includes(":")).toBe(true);
    const inside = prefixes.some((p) => ip.startsWith(p)) || (hi16(ip) === 0x2a06 && Number.parseInt(ip.split(":")[1]!, 16) >= 0x98c0 && Number.parseInt(ip.split(":")[1]!, 16) < 0x98c8);
    expect(inside).toBe(true);
  }
});

test("sampling refuses a mixed-family list instead of silently skewing it", () => {
  expect(() => sampleIps([...v4, ...v6], 5)).toThrow();
});

test("validCidr accepts ranges and rejects anything else a bad download could contain", () => {
  for (const ok of ["104.16.0.0/13", "2606:4700::/32", "2a06:98c0::/29"]) expect(validCidr(ok)).toBe(true);
  for (const bad of ["", "<html>", "104.16.0.0", "104.16.0.0/0", "999.1.1.1/8", "2606:4700::/200", "evil.example/8"]) expect(validCidr(bad)).toBe(false);
});

test("preferIps keeps only IPs that reach the origin and orders them by measured time, IPv6 included", async () => {
  const times: Record<string, number | null> = { "1.1.1.1": 90, "2.2.2.2": null, "2606:4700::1": 20, "4.4.4.4": 55 };
  const r = await preferIps("api.example", { enabled: true, ips: Object.keys(times) }, { sample: 0, ranges: [], resolve: async () => [], probe: async (_h, ip) => times[ip] ?? null });
  expect(r.map((x) => x.ip)).toEqual(["2606:4700::1", "4.4.4.4", "1.1.1.1"]);
});

test("the host's own DNS answers (A and AAAA) are probed when they lie in Cloudflare's ranges; others are ignored; no random IPv6 is drawn", async () => {
  const seen: string[] = [];
  await preferIps("api.example", { enabled: true }, {
    sample: 8,
    resolve: async () => ["104.16.5.5", "2606:4700:3030::6815:3e2c", "203.0.113.9", "2001:db8::1"],
    probe: async (_h, ip) => { seen.push(ip); return null; },
  });
  expect(seen).toContain("104.16.5.5");
  expect(seen).toContain("2606:4700:3030::6815:3e2c");
  expect(seen).not.toContain("203.0.113.9");
  expect(seen).not.toContain("2001:db8::1");
  expect(seen.filter((i) => i.includes(":"))).toEqual(["2606:4700:3030::6815:3e2c"]);
  expect(seen.filter((i) => !i.includes(":")).length).toBe(9);
});

test("inRanges decides by prefix for both families", () => {
  expect(inRanges("104.16.5.5", BUILTIN_RANGES)).toBe(true);
  expect(inRanges("104.15.255.255", BUILTIN_RANGES)).toBe(false);
  expect(inRanges("2606:4700:3037::ac43:dbf7", BUILTIN_RANGES)).toBe(true);
  expect(inRanges("2607:4700::1", BUILTIN_RANGES)).toBe(false);
});

test("a disabled preset or an IP-literal host selects nothing", async () => {
  const probe = async () => 1;
  expect(await preferIps("api.example", { enabled: false, ips: ["1.1.1.1"] }, { probe })).toEqual([]);
  expect(await preferIps("1.2.3.4", { enabled: true, ips: ["1.1.1.1"] }, { probe })).toEqual([]);
});

const tmp: string[] = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cf-")); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop()!, { recursive: true, force: true }); });
const lists = (a: string, b: string) => (async (u: string | URL | Request) => new Response(String(u).endsWith("v4") ? a : b)) as unknown as typeof fetch;

test("ranges: a fresh download is used and cached; a stale cache is replaced; a fresh cache is not refetched", async () => {
  const d = dir();
  const got = await loadRanges({ dir: d, fetch: lists("10.0.0.0/8\n11.0.0.0/8\n", "2001:db8::/32\n"), now: () => 1000 });
  expect(got).toEqual({ cidrs: ["10.0.0.0/8", "11.0.0.0/8", "2001:db8::/32"], source: "fetched" });
  let calls = 0;
  const counting = (async () => { calls++; return new Response("12.0.0.0/8"); }) as unknown as typeof fetch;
  expect((await loadRanges({ dir: d, fetch: counting, now: () => 2000 })).source).toBe("cache");
  expect(calls).toBe(0);
  const later = await loadRanges({ dir: d, fetch: lists("12.0.0.0/8", "2001:db9::/32"), now: () => 1000 + 25 * 3600_000 });
  expect(later.cidrs).toEqual(["12.0.0.0/8", "2001:db9::/32"]);
});

test("ranges: a bad or failed download keeps the previous list, and falls back to the built-in one when there is none", async () => {
  const d = dir();
  await loadRanges({ dir: d, fetch: lists("10.0.0.0/8", "2001:db8::/32"), now: () => 0 });
  const later = 25 * 3600_000;
  const logs: string[] = [];
  const bad = await loadRanges({ dir: d, fetch: lists("<html>blocked</html>", "2001:db8::/32"), now: () => later, log: (m) => logs.push(m) });
  expect(bad).toEqual({ cidrs: ["10.0.0.0/8", "2001:db8::/32"], source: "cache" });
  expect(logs.length).toBe(1);
  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect((await loadRanges({ dir: dir(), fetch: down })).source).toBe("builtin");
  expect((await loadRanges({ dir: dir(), fetch: lists("", "") })).source).toBe("builtin");
});

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(true); });
const marked = { "x-cgs-origin": "1" };

test("when no candidate answers on the normal route the router pins the fastest Cloudflare IP and sends requests through it", async () => {
  const pinnedTo: string[] = [];
  const logs: string[] = [];
  const r = createRouter({
    upstream: ["https://blocked.example", "https://apia.example"],
    directFetch: async () => { throw new Error("connection reset"); },
    cloudflare: { enabled: true, ips: ["9.9.9.9", "2606:4700::1111"] },
    cloudflareHooks: {
      // blocked.example never completes a handshake (RST on its SNI); apia.example does, the IPv6 edge being fastest
      probe: async (host, ip) => (host === "apia.example" ? (ip === "2606:4700::1111" ? 30 : 80) : null),
      pinned: (host, ip) => async (req) => { pinnedTo.push(`${host}@${ip}`); return new Response(`via ${new URL(req.url).pathname}`, { headers: marked }); },
    },
    log: (m) => logs.push(m),
  });
  await r.ready();
  expect(r.upstream()).toBe("https://apia.example");
  expect(await (await r.fetch(new Request("http://x.invalid/api/device/sessions"))).text()).toBe("via /api/device/sessions");
  expect(pinnedTo.every((p) => p === "apia.example@2606:4700::1111")).toBe(true);
  r.stop();
});

test("Cloudflare IPs are not probed when a candidate answers on the normal route", async () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok", { headers: marked }) });
  servers.push(s);
  let probed = 0;
  const r = createRouter({ upstream: [`http://127.0.0.1:${s.port}`], cloudflare: { enabled: true, ips: ["9.9.9.9"] }, cloudflareHooks: { probe: async () => { probed++; return 1; } } });
  await r.ready();
  expect(probed).toBe(0);
  expect(r.upstream()).toBe(`http://127.0.0.1:${s.port}`);
  r.stop();
});
