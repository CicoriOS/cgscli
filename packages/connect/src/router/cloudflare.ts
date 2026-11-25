// Cloudflare preferred-IP selection (ADR 0015). For a Cloudflare-fronted API host, TLS handshakes are made to many
// Cloudflare edge IPs with the host's own name as SNI, and the fastest IP that really reaches our origin (HEALTH_PATH,
// status < 300, origin marker) is kept. Measuring with a TLS handshake instead of ICMP needs no privileges. The
// certificate is verified as usual, so an address from a wrong list cannot impersonate the host.
//
// Candidate addresses: random IPv4 inside the published ranges (dense with live edges) plus the host's own DNS answers,
// A and AAAA. Random IPv6 is NOT drawn: a /32 holds 2^96 addresses and a random one is practically never an edge
// (checked 2026-11-25: 0 of 12 answered, while the DNS-given addresses and their neighbours did). Ranges still vet DNS answers.
// Verified on Bun 1.4.4 (V13): tls.connect({host: ip, servername}) + HTTP/2 over that socket.
import dns from "node:dns/promises";
import fs from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { HEALTH_PATH, ORIGIN_HEADER } from "./tunnel.ts";

/** Built-in copy of Cloudflare's published ranges (https://www.cloudflare.com/ips-v4, /ips-v6); the fallback when no fresher list exists. */
export const BUILTIN_RANGES: readonly string[] = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

/** What the API server's preset names. Only `enabled` is required; everything else has a default. */
export interface CloudflarePreset {
  enabled: boolean;
  /** Extra IPs to try first (e.g. known-good edges), besides the ranges and DNS. */
  ips?: string[];
  /** Random IPv4 addresses drawn from the ranges per selection. */
  sample?: number;
}

const V4 = (s: string) => s.split(".").reduce((n, p) => n * 256n + BigInt(p), 0n);
const fromV4 = (n: bigint) => [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join(".");
function parseV6(s: string): bigint {
  const [head, tail = ""] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return groups.reduce((n, g) => (n << 16n) + BigInt(`0x${g || "0"}`), 0n);
}
const fromV6 = (n: bigint) => Array.from({ length: 8 }, (_, i) => ((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)).join(":");

const CIDR = /^([0-9a-f:.]+)\/(\d{1,3})$/i;
/** True for `a.b.c.d/n` or an IPv6 `x::y/n` that parses; used to reject anything odd in a downloaded list. */
export function validCidr(s: string): boolean {
  const m = CIDR.exec(s.trim());
  if (!m) return false;
  const bits = Number(m[2]);
  if (net.isIPv4(m[1]!)) return bits >= 8 && bits <= 32;
  return net.isIPv6(m[1]!) && bits >= 16 && bits <= 128;
}

/** `count` distinct addresses drawn at random from the CIDR blocks of one family (network and broadcast addresses skipped). */
export function sampleIps(cidrs: readonly string[], count: number, rand: () => number = Math.random): string[] {
  const blocks = cidrs.filter(validCidr).map((c) => {
    const [base, bits] = c.split("/");
    const v6 = base!.includes(":");
    const width = BigInt(v6 ? 128 : 32) - BigInt(bits!);
    const start = v6 ? parseV6(base!) : V4(base!);
    return { v6, size: 1n << width, start: (start >> width) << width };
  });
  if (blocks.length === 0 || new Set(blocks.map((b) => b.v6)).size > 1) throw new Error("sampleIps takes the ranges of a single address family");
  const total = blocks.reduce((n, b) => n + b.size, 0n);
  const pick = () => { // uniform over the union of blocks; 128 random bits keep the modulo bias negligible even for IPv6 blocks
    let r = 0n;
    for (let i = 0; i < 4; i++) r = (r << 32n) + BigInt(Math.floor(rand() * 2 ** 32));
    return r % total;
  };
  const out = new Set<string>();
  for (let guard = 0; out.size < count && guard < count * 20; guard++) {
    let k = pick();
    for (const b of blocks) {
      if (k < b.size) { if (k > 0n && k < b.size - 1n) out.add((b.v6 ? fromV6 : fromV4)(b.start + k)); break; }
      k -= b.size;
    }
  }
  return [...out];
}

const family = (cidrs: readonly string[], v6: boolean) => cidrs.filter((c) => validCidr(c) && c.includes(":") === v6);

export interface RangesOptions {
  /** Where the downloaded lists are kept between runs (not secret). */
  dir?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** A cached list older than this is fetched again. Default 24 h. */
  maxAgeMs?: number;
  log?: (m: string) => void;
}
const RANGES_URLS = ["https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"] as const;

/**
 * The ranges to draw from: the official lists fetched now when the cache is stale, else the cached copy, else the built-in one.
 * A download that is empty or has an invalid line is discarded as a whole.
 */
export async function loadRanges(o: RangesOptions = {}): Promise<{ cidrs: string[]; source: "fetched" | "cache" | "builtin" }> {
  const now = o.now ?? Date.now;
  const file = o.dir ? path.join(o.dir, "cloudflare-ranges.json") : null;
  let cached: { fetchedAt: number; cidrs: string[] } | null = null;
  try {
    const j = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (j && Array.isArray(j.cidrs) && j.cidrs.every((c: unknown) => typeof c === "string" && validCidr(c)) && family(j.cidrs, false).length && family(j.cidrs, true).length) cached = j;
  } catch { /* no usable cache */ }
  if (cached && now() - cached.fetchedAt < (o.maxAgeMs ?? 24 * 3600_000)) return { cidrs: cached.cidrs, source: "cache" };
  try {
    const f = o.fetch ?? fetch;
    const parts = await Promise.all(RANGES_URLS.map(async (u) => {
      const r = await f(u, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
      return (await r.text()).split(/\s+/).filter(Boolean);
    }));
    const cidrs = parts.flat();
    if (!cidrs.every(validCidr) || !family(cidrs, false).length || !family(cidrs, true).length) throw new Error("downloaded list is not a list of CIDR ranges");
    if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ fetchedAt: now(), cidrs })); }
    return { cidrs, source: "fetched" };
  } catch (e) {
    o.log?.(`cloudflare ranges not updated: ${e instanceof Error ? e.message : e}`);
    return cached ? { cidrs: cached.cidrs, source: "cache" } : { cidrs: [...BUILTIN_RANGES], source: "builtin" };
  }
}

/** One timed health request to `ip` with `host` as SNI and Host; null when it fails or is not our origin. */
export async function probeIp(host: string, ip: string, timeoutMs: number): Promise<number | null> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let session: http2.ClientHttp2Session | null = null;
    const sock = tls.connect({ host: ip, port: 443, servername: host, ALPNProtocols: ["h2"] });
    const finish = (v: number | null) => { clearTimeout(timer); session?.destroy(); sock.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.once("error", () => finish(null));
    sock.once("secureConnect", () => {
      if (sock.alpnProtocol !== "h2") return finish(null);
      session = http2.connect(`https://${host}`, { createConnection: () => sock });
      session.once("error", () => finish(null));
      const r = session.request({ ":path": HEALTH_PATH, ":authority": host });
      r.once("error", () => finish(null));
      r.once("response", (h) => finish(Number(h[":status"]) < 300 && h[ORIGIN_HEADER.toLowerCase()] ? performance.now() - t0 : null));
      r.resume(); r.end();
    });
  });
}

export interface PreferOptions {
  sample?: number; concurrency?: number; timeoutMs?: number; probe?: typeof probeIp; ranges?: readonly string[]; rand?: () => number; log?: (m: string) => void;
  /** Addresses the host's DNS gives (A and AAAA); injectable for tests. */
  resolve?: (host: string) => Promise<string[]>;
}

async function dnsAddresses(host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([dns.resolve4(host).catch(() => []), dns.resolve6(host).catch(() => [])]);
  return [...a, ...aaaa];
}

/** True when `ip` lies inside one of the CIDR blocks. */
export function inRanges(ip: string, cidrs: readonly string[]): boolean {
  const v6 = ip.includes(":");
  const n = v6 ? parseV6(ip) : V4(ip);
  return cidrs.some((c) => {
    if (!validCidr(c) || c.includes(":") !== v6) return false;
    const [base, bits] = c.split("/");
    const w = BigInt(v6 ? 128 : 32) - BigInt(bits!);
    return n >> w === (v6 ? parseV6(base!) : V4(base!)) >> w;
  });
}

/** Candidate IPs ordered fastest first; empty when none reaches the origin. */
export async function preferIps(host: string, preset: CloudflarePreset, o: PreferOptions = {}): Promise<{ ip: string; ms: number }[]> {
  if (!preset.enabled || net.isIP(host)) return [];
  const probe = o.probe ?? probeIp;
  const ranges = o.ranges ?? BUILTIN_RANGES;
  const v4 = family(ranges, false);
  const dnsIps = (await (o.resolve ?? dnsAddresses)(host)).filter((ip) => net.isIP(ip) && inRanges(ip, ranges));
  const ips = [...new Set([
    ...(preset.ips ?? []).filter((x) => net.isIP(x)),
    ...dnsIps,
    ...(v4.length ? sampleIps(v4, preset.sample ?? o.sample ?? 24, o.rand) : []),
  ])];
  const results: { ip: string; ms: number }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 12, ips.length) }, async () => {
    while (next < ips.length) { const ip = ips[next++]!; const ms = await probe(host, ip, o.timeoutMs ?? 4000); if (ms !== null) results.push({ ip, ms }); }
  }));
  results.sort((a, b) => a.ms - b.ms);
  o.log?.(`cloudflare: ${results.length}/${ips.length} IPs reach ${host}${results[0] ? `, best ${results[0].ip} ${Math.round(results[0].ms)}ms` : ""}`);
  return results;
}

/** A `fetch` for `host` that connects to `ip`, with SNI and Host set to `host` (one request per connection, streamed). */
export function pinnedFetch(host: string, ip: string): (req: Request) => Promise<Response> {
  return (req) => new Promise<Response>((resolve, reject) => {
    const u = new URL(req.url);
    const sock = tls.connect({ host: ip, port: 443, servername: host, ALPNProtocols: ["h2"] });
    const session = http2.connect(`https://${host}`, { createConnection: () => sock });
    const fail = (e: unknown) => { session.destroy(); sock.destroy(); reject(e); };
    sock.once("error", fail); session.once("error", fail);
    const headers: http2.OutgoingHttpHeaders = { ":method": req.method, ":path": u.pathname + u.search, ":authority": host };
    for (const [k, v] of req.headers) if (k !== "host" && k !== "connection" && k !== "transfer-encoding") headers[k] = v;
    const r = session.request(headers);
    const onAbort = () => { r.close(http2.constants.NGHTTP2_CANCEL); fail(req.signal.reason); };
    req.signal.addEventListener("abort", onAbort, { once: true });
    r.once("error", fail);
    r.once("response", (h) => {
      const rh = new Headers();
      for (const [k, v] of Object.entries(h)) if (!k.startsWith(":") && v !== undefined) for (const x of Array.isArray(v) ? v : [v]) rh.append(k, String(x));
      const status = Number(h[":status"]);
      const body = status === 204 || status === 304 ? null : new ReadableStream<Uint8Array>({
        start(c) { r.on("data", (d: Buffer) => c.enqueue(new Uint8Array(d))); r.on("end", () => { req.signal.removeEventListener("abort", onAbort); session.close(); c.close(); }); r.on("error", (e) => c.error(e)); },
        cancel() { r.close(http2.constants.NGHTTP2_CANCEL); session.close(); },
      });
      if (!body) { session.close(); req.signal.removeEventListener("abort", onAbort); }
      resolve(new Response(body, { status, headers: rh }));
    });
    req.arrayBuffer().then((b) => r.end(b.byteLength ? Buffer.from(b) : undefined), fail);
  });
}
