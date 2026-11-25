// Direct-first API routing with relay tunnel fallback (port of new-api tunnelkit/agent: route.go, agent.go).
import http2 from "node:http2";
import fs from "node:fs";
import path from "node:path";
import type { Router, RouterStatus } from "../contracts.ts";
import { PRODUCTION_ROOT_KEYS, rootsFromHex, verifyBundle, type Roots, type TunnelConfig } from "./bundle.ts";
import { dialTunnel, HEALTH_PATH, ORIGIN_HEADER, targetKey, wsCarrier, type Carrier, type Target } from "./tunnel.ts";
import { bootstrap } from "./bootstrap.ts";
import { loadRanges, pinnedFetch, preferIps, probeIp, type CloudflarePreset } from "./cloudflare.ts";

export const CONTROL_PREFIX = "/_cgs-agent/";
const MAX_REQUEST_BODY = 64 << 20;
const RELAY_ATTEMPTS = 3;
const HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

export interface RouterOptions {
  /** API server origin(s), e.g. https://ai.example.com. With several, Bootstrap picks the fastest healthy one (ADR 0015). */
  upstream: string | string[];
  /** Keeps the verified tunnel bundle across restarts (not secret). */
  dataDir?: string;
  roots?: Roots;
  allowTestNets?: boolean;
  carrier?: Carrier;
  directFetch?: (req: Request) => Promise<Response>;
  stickyMs?: number;
  probeEveryMs?: number;
  returnAfter?: number;
  probeTimeoutMs?: number;
  log?: (msg: string) => void;
  /**
   * Cloudflare preset (ADR 0015). Used only when no candidate answers over the system's own route: the fastest Cloudflare edge IP
   * that really reaches the origin is pinned for that host (SNI and Host stay the host's own name).
   */
  cloudflare?: CloudflarePreset;
  /** Test seams for the Cloudflare selection. */
  cloudflareHooks?: { probe?: typeof probeIp; pinned?: typeof pinnedFetch };
}

export interface ControlStatus extends RouterStatus { tunnel_configured: boolean; config_version?: number }
export interface RouterImpl extends Router {
  /** Serves /_cgs-agent/v1/{status,tunnel}; null when the request is not a control request. */
  handleControl(req: Request): Promise<Response | null>;
  controlStatus(): ControlStatus;
  stop(): void;
  /** Resolves when the first Bootstrap has finished (immediately with a single candidate). */
  ready(): Promise<void>;
  /** Origin currently used for direct requests. */
  upstream(): string;
}

const idempotent = (m: string) => m === "GET" || m === "HEAD" || m === "OPTIONS";

/** An error response without the origin marker was made up by a CDN in front of the origin: the request never arrived. */
function cdnFailure(r: Response): boolean {
  if (r.headers.get(ORIGIN_HEADER)) return false;
  return r.status === 502 || r.status === 503 || r.status === 504 || (r.status >= 520 && r.status <= 530);
}

function targetsOf(cfg: TunnelConfig): Target[] {
  return cfg.endpoints.flatMap((endpoint) => (endpoint.ips?.length ? endpoint.ips.map((e) => ({ endpoint, ip: e.ip })) : [{ endpoint }]));
}

export function createRouter(o: RouterOptions): RouterImpl {
  const candidates = (Array.isArray(o.upstream) ? o.upstream : [o.upstream]).map((s) => new URL(s));
  if (candidates.length === 0) throw new Error("no upstream given");
  for (const c of candidates) if ((c.protocol !== "https:" && c.protocol !== "http:") || !c.host) throw new Error("upstream must be an http(s) URL with a host");
  let up = candidates[0]!;
  const roots = o.roots ?? rootsFromHex(PRODUCTION_ROOT_KEYS);
  const carrier = o.carrier ?? wsCarrier;
  const plainDirect = o.directFetch ?? ((r: Request) => fetch(r));
  let pin: { host: string; fetch: (r: Request) => Promise<Response> } | null = null;
  const direct = (r: Request) => (pin && new URL(r.url).host === pin.host ? pin.fetch(r) : plainDirect(r));
  const sticky = o.stickyMs ?? 10 * 60_000;
  const probeEvery = o.probeEveryMs ?? 60_000;
  const returnAfter = o.returnAfter ?? 3;
  const probeTimeout = o.probeTimeoutMs ?? 3000;
  const log = o.log ?? (() => {});
  const bundleFile = o.dataDir ? path.join(o.dataDir, "tunnel.json") : null;

  let cfg: TunnelConfig | null = null;
  let mode: "direct" | "relay" = "direct";
  let version = 0;
  let relayUntil = 0;
  let okStreak = 0;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let ranked: Target[] = [];
  let current: Target | null = null;
  let selecting: Promise<void> | null = null;
  let session: Promise<http2.ClientHttp2Session> | null = null;
  const subs = new Set<(s: RouterStatus) => void>();
  let waiters: (() => void)[] = [];

  const status = (): RouterStatus => ({ version, mode, ...(mode === "relay" && current ? { endpoint: targetKey(current) } : {}) });
  const controlStatus = (): ControlStatus => ({ ...status(), tunnel_configured: cfg !== null, ...(cfg ? { config_version: cfg.version } : {}) });
  function bump() {
    version++;
    const w = waiters; waiters = [];
    w.forEach((f) => f());
    const s = status();
    subs.forEach((f) => f(s));
  }

  function closeSession() {
    const s = session; session = null;
    void s?.then((c) => c.close(), () => {});
  }

  async function openSession(t: Target, keys: Uint8Array[], signal: AbortSignal): Promise<http2.ClientHttp2Session> {
    const stream = await dialTunnel(t, keys, signal, carrier);
    const client = http2.connect(`http://${up.host}`, { createConnection: () => stream });
    const ready = Promise.withResolvers<void>();
    client.once("connect", () => ready.resolve());
    client.on("error", (e) => ready.reject(e));
    client.on("close", () => { if (session && client.destroyed) session = null; });
    await ready.promise;
    client.removeAllListeners("error");
    client.on("error", () => {});
    return client;
  }

  async function relayTarget(signal: AbortSignal): Promise<Target> {
    for (;;) {
      if (!cfg) throw new Error("no tunnel configuration");
      if (current) return current;
      if (!selecting) startSelect();
      await Promise.race([selecting, new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(signal.reason), { once: true }))]);
      if (!current) throw new Error("no relay endpoint is reachable");
    }
  }

  function tunnelFailed(t: Target, err: unknown) {
    if (!current || targetKey(current) !== targetKey(t)) return;
    log(`relay ${targetKey(t)} failed: ${err instanceof Error ? err.message : err}`);
    ranked = ranked.filter((x) => targetKey(x) !== targetKey(t));
    current = ranked[0] ?? null;
    closeSession();
    bump();
  }

  async function probe(t: Target, keys: Uint8Array[]): Promise<number | null> {
    const signal = AbortSignal.timeout(probeTimeout);
    let client: http2.ClientHttp2Session | null = null;
    try {
      client = await openSession(t, keys, signal);
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const r = await h2Request(client, "GET", HEALTH_PATH, {}, undefined, signal);
        await r.arrayBuffer();
        if (r.status >= 300) break;
        samples.push(performance.now() - start);
      }
      if (samples.length === 0) return null;
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)]!;
    } catch { return null; } finally { client?.close(); }
  }

  function startSelect() {
    const c = cfg;
    if (!c) return;
    const run = async () => {
      const targets = targetsOf(c);
      const results: { t: Target; ms: number }[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(16, targets.length) }, async () => {
        while (next < targets.length) {
          const t = targets[next++]!;
          const ms = await probe(t, c.gateway_keys);
          if (ms !== null) results.push({ t, ms });
        }
      }));
      selecting = null;
      if (results.length === 0) { log("no relay endpoint answered"); if (!current) bump(); return; }
      results.sort((a, b) => a.ms - b.ms || (a.t.endpoint.priority ?? 0) - (b.t.endpoint.priority ?? 0));
      ranked = results.map((r) => r.t);
      if (!current || targetKey(current) !== targetKey(ranked[0]!)) { current = ranked[0]!; closeSession(); log(`relay endpoint selected: ${targetKey(current)}`); }
      bump();
    };
    selecting = run();
  }

  async function directHealthy(): Promise<boolean> {
    try {
      const r = await direct(new Request(new URL(HEALTH_PATH, up), { signal: AbortSignal.timeout(5000) }));
      await r.arrayBuffer();
      return r.status < 300 && !!r.headers.get(ORIGIN_HEADER);
    } catch { return false; }
  }

  function probeDirect() {
    if (probeTimer) return;
    probeTimer = setInterval(async () => {
      const ok = await directHealthy();
      if (mode !== "relay") { clearInterval(probeTimer!); probeTimer = null; return; }
      okStreak = ok ? okStreak + 1 : 0;
      if (okStreak >= returnAfter && Date.now() >= relayUntil) {
        log("direct reachable again; relay disabled");
        mode = "direct";
        clearInterval(probeTimer!); probeTimer = null;
        closeSession();
        bump();
      }
    }, probeEvery);
    probeTimer.unref?.();
  }

  function enterRelay(reason: string): boolean {
    if (!cfg || cfg.endpoints.length === 0) return false;
    if (mode !== "relay") { log(`direct unavailable (${reason}); relay enabled`); mode = "relay"; bump(); }
    relayUntil = Date.now() + sticky;
    okStreak = 0;
    probeDirect();
    if (!selecting) startSelect();
    return true;
  }

  const sendDirect = (req: Request, body: Uint8Array | undefined) =>
    direct(new Request(new URL(new URL(req.url).pathname + new URL(req.url).search, up), { method: req.method, headers: cleanHeaders(req.headers), body, signal: req.signal }));

  async function sendRelay(req: Request, body: Uint8Array | undefined): Promise<Response> {
    let last: unknown;
    const u = new URL(req.url);
    for (let i = 0; i < RELAY_ATTEMPTS; i++) {
      let target: Target;
      try { target = await relayTarget(req.signal); } catch (e) { last = e; break; }
      let dialed = false;
      try {
        session ??= openSession(target, cfg!.gateway_keys, req.signal);
        const client = await session;
        dialed = true;
        return await h2Request(client, req.method, u.pathname + u.search, Object.fromEntries(cleanHeaders(req.headers)), body, req.signal);
      } catch (e) {
        last = e;
        if (req.signal.aborted) throw e;
        if (!dialed) closeSession();
        tunnelFailed(target, e);
        if (dialed && !idempotent(req.method)) throw e; // request may have reached the server
      }
    }
    try { return await sendDirect(req, body); } catch (e) { throw new Error(`direct and relay both unavailable: ${last instanceof Error ? last.message : last}; ${e instanceof Error ? e.message : e}`); }
  }

  async function routedFetch(req: Request): Promise<Response> {
    await firstBoot;
    const buf = req.body ? new Uint8Array(await req.arrayBuffer()) : undefined;
    if (buf && buf.length > MAX_REQUEST_BODY) return new Response("cgs-agent: request body too large", { status: 413 });
    if (mode === "direct") {
      let resp: Response | null = null, err: unknown = null, sent = false;
      try { resp = await sendDirect(req, buf); sent = true; } catch (e) { err = e; }
      // The origin may have gone away while others work: re-run Bootstrap and retry once on another candidate, but only when the
      // request cannot have been processed twice (a CDN-made error, or an idempotent method).
      if (candidates.length > 1 && !req.signal.aborted && ((resp && cdnFailure(resp)) || (err && idempotent(req.method)))) {
        const before = up;
        await rebootstrap();
        if (up !== before) {
          void resp?.body?.cancel();
          try { resp = await sendDirect(req, buf); err = null; } catch (e) { resp = null; err = e; }
          if (resp && !cdnFailure(resp)) return resp;
        }
      }
      if (resp && !cdnFailure(resp)) return resp;
      const reason = err ? String(err instanceof Error ? err.message : err) : `HTTP ${resp!.status} without origin marker`;
      if (req.signal.aborted || !enterRelay(reason)) { if (resp) return resp; throw err; }
      if (resp) { if (!idempotent(req.method)) return resp; void resp.body?.cancel(); }
      else if (sent && !idempotent(req.method)) throw err;
    }
    try { return await sendRelay(req, buf); } catch (e) {
      if (req.signal.aborted) throw e;
      return new Response(`cgs-agent: API server unreachable: ${e instanceof Error ? e.message : e}`, { status: 502 });
    }
  }

  function setTunnel(bundle: unknown) {
    const next = verifyBundle(bundle, { roots, allowTestNets: o.allowTestNets });
    if (cfg && next.version < cfg.version) throw new Error("tunnel config is older than the current one");
    const changed = !cfg || next.version !== cfg.version;
    cfg = next;
    if (bundleFile) { fs.mkdirSync(path.dirname(bundleFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(bundleFile, typeof bundle === "string" ? bundle : JSON.stringify(bundle)); }
    if (changed) { ranked = []; current = null; closeSession(); if (mode === "relay" && !selecting) startSelect(); bump(); }
  }

  function clearTunnel() {
    if (bundleFile) fs.rmSync(bundleFile, { force: true });
    if (!cfg) return;
    cfg = null; ranked = []; current = null; mode = "direct";
    closeSession();
    bump();
  }

  if (bundleFile && fs.existsSync(bundleFile)) {
    try { cfg = verifyBundle(fs.readFileSync(bundleFile, "utf8"), { roots, allowTestNets: o.allowTestNets }); } catch (e) { log(`stored tunnel config ignored: ${e instanceof Error ? e.message : e}`); }
  }

  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  async function handleControl(req: Request): Promise<Response | null> {
    const u = new URL(req.url);
    if (!u.pathname.startsWith(CONTROL_PREFIX)) return null;
    if (u.pathname === `${CONTROL_PREFIX}v1/status` && req.method === "GET") {
      const raw = u.searchParams.get("after");
      const after = raw === null ? null : Number(raw);
      if (after !== null && !Number.isInteger(after)) return new Response("bad after", { status: 400 });
      if (after !== null && version <= after) {
        const gate = Promise.withResolvers<void>();
        waiters.push(gate.resolve);
        const t = setTimeout(gate.resolve, 25_000);
        req.signal.addEventListener("abort", gate.resolve, { once: true });
        await gate.promise;
        clearTimeout(t);
      }
      return json(controlStatus());
    }
    if (u.pathname === `${CONTROL_PREFIX}v1/tunnel` && req.method === "PUT") {
      try { setTunnel(await req.text()); } catch (e) { return new Response(e instanceof Error ? e.message : String(e), { status: 400 }); }
      return json(controlStatus());
    }
    if (u.pathname === `${CONTROL_PREFIX}v1/tunnel` && req.method === "DELETE") { clearTunnel(); return new Response(null, { status: 204 }); }
    return new Response("not found", { status: 404 });
  }

  let booting: Promise<void> | null = null;
  const cf = o.cloudflare?.enabled ? o.cloudflare : null;

  /** No candidate answers on the plain route: pin the fastest Cloudflare IP across the https candidates. */
  async function cloudflareSelect(): Promise<URL | null> {
    const hosts = [...new Set(candidates.filter((c) => c.protocol === "https:").map((c) => c.hostname))];
    const { cidrs, source } = await loadRanges({ dir: o.dataDir, log });
    log(`cloudflare ranges: ${cidrs.length} (${source})`);
    const per = await Promise.all(hosts.map(async (h) => ({ h, best: (await preferIps(h, cf!, { probe: o.cloudflareHooks?.probe, ranges: cidrs, log }))[0] })));
    const win = per.filter((x) => x.best).sort((a, b) => a.best!.ms - b.best!.ms)[0];
    if (!win) return null;
    pin = { host: candidates.find((c) => c.hostname === win.h)!.host, fetch: (o.cloudflareHooks?.pinned ?? pinnedFetch)(win.h, win.best!.ip) };
    log(`cloudflare: ${win.h} via ${win.best!.ip}`);
    return candidates.find((c) => c.hostname === win.h)!;
  }

  function rebootstrap(): Promise<void> {
    if (candidates.length < 2 && !cf) return Promise.resolve();
    booting ??= (async () => {
      let won = await bootstrap(candidates, { direct, log });
      if (!won && cf) won = await cloudflareSelect();
      else if (won && pin && won.host !== pin.host) pin = null;
      if (won && won.origin !== up.origin) { log(`API origin selected: ${won.host}`); up = won; closeSession(); bump(); }
    })().finally(() => { booting = null; });
    return booting;
  }
  const firstBoot = rebootstrap();

  return {
    fetch: routedFetch,
    ready: () => firstBoot,
    upstream: () => up.origin,
    status,
    controlStatus,
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
    setTunnel,
    clearTunnel,
    handleControl,
    stop() { clearInterval(probeTimer ?? undefined); closeSession(); },
  };
}

function cleanHeaders(h: Headers): Headers {
  const out = new Headers(h);
  for (const k of HOP) out.delete(k);
  out.delete("host");
  return out;
}

/** One HTTP/2 request on a tunnel session, returned as a streaming Response. */
function h2Request(client: http2.ClientHttp2Session, method: string, p: string, headers: Record<string, string>, body: Uint8Array | undefined, signal: AbortSignal): Promise<Response> {
  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  const req = client.request({ ...headers, ":method": method, ":path": p });
  const onAbort = () => req.close(http2.constants.NGHTTP2_CANCEL);
  signal.addEventListener("abort", onAbort, { once: true });
  req.on("error", (e) => { reject(e); });
  req.on("response", (h) => {
    const rh = new Headers();
    for (const [k, v] of Object.entries(h)) if (!k.startsWith(":") && v !== undefined) for (const x of Array.isArray(v) ? v : [v]) rh.append(k, String(x));
    for (const k of HOP) rh.delete(k);
    const status = Number(h[":status"]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { req.on("data", (d: Buffer) => c.enqueue(new Uint8Array(d))); req.on("end", () => { signal.removeEventListener("abort", onAbort); c.close(); }); req.on("error", (e) => c.error(e)); },
      cancel() { req.close(http2.constants.NGHTTP2_CANCEL); },
    });
    resolve(new Response(status === 204 || status === 304 ? null : stream, { status, headers: rh }));
  });
  req.end(body ? Buffer.from(body) : undefined);
  return promise;
}

export { rootsFromHex, seal, keyId, PRODUCTION_ROOT_KEYS, verifyBundle } from "./bundle.ts";
export { makeWsCarrier, wsCarrier, type Carrier, type Target } from "./tunnel.ts";
export { noiseInitiator, noiseResponder } from "./noise.ts";
export * from "./poller.ts";
