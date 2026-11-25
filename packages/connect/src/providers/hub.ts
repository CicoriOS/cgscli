// Provider hub: slot credentials, request handling for omp's provider baseUrl (handled in-process) and rotation notices.
import { CGSCONNECT_ORIGIN, type ChannelEvent, type ModelManifest, type ProviderHub, type RotationEvent, type Router } from "../contracts.ts";
import { buildManifest, CHANNELS, isRotationNotice, slotSecret, slotShapeError, type Channel, type Slot, type SitePrice } from "./channels.ts";
import { ChannelTracker, parseUpstream, refreshSession, UPSTREAM_HEADER, usageLimitRewrite, DEFAULT_COOLDOWN_SEC, type Upstream } from "./upstream.ts";

export interface ProviderHubOptions {
  router: Router;
  models?: string[];
  pricing?: Record<string, SitePrice>;
  /** Test seam. */
  now?: () => number;
}

export interface ProviderHubImpl extends ProviderHub {
  setModels(ids: string[], pricing?: Record<string, SitePrice>): void;
  /** Slot currently preferred for a channel (what a login/refresh in the extension should hand out). */
  currentSlot(provider: Channel): Slot | null;
  /** Serves requests addressed to CGSCONNECT_ORIGIN (manifest, slot, provider traffic); reached by direct call, never a socket. */
  fetch(req: Request): Promise<Response>;
}

const HOP = ["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"];

export function createProviderHub(o: ProviderHubOptions): ProviderHubImpl {
  const now = o.now ?? Date.now;
  const slots = new Map<Channel, Slot[]>();
  const exhausted = new Set<string>();
  /** Slots cooled by NewAPI's `rotate=1`, with the time they may be used again. */
  const cooling = new Map<string, number>();
  const listeners: ((e: RotationEvent) => void)[] = [];
  const channelListeners: ((e: ChannelEvent) => void)[] = [];
  const tracker = new ChannelTracker();
  /** Providers whose NEXT request starts a fresh session identity (NewAPI reported `refresh=1` or a channel switch). */
  const freshSession = new Set<Channel>();
  let models = o.models ?? [];
  let pricing = o.pricing ?? {};

  const base = CGSCONNECT_ORIGIN;

  const key = (s: Slot) => `${s.provider}/${s.id}`;
  const live = (p: Channel) => (slots.get(p) ?? []).filter((s) => !exhausted.has(key(s)) && (cooling.get(key(s)) ?? 0) <= now());

  function slotOf(req: Request): Slot | null {
    const auth = req.headers.get("authorization") ?? "";
    const presented = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : (req.headers.get("x-api-key") ?? "");
    for (const list of slots.values()) for (const s of list) if (presented && slotSecret(s) === presented) return s;
    return null;
  }

  async function handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.origin !== CGSCONNECT_ORIGIN) return new Response("forbidden", { status: 403 });
    const rest = u.pathname;
    if (rest === "/_cgsconnect/manifest") return Response.json(buildManifest(base, models, pricing));
    if (rest === "/_cgsconnect/slot") {
      const p = CHANNELS.find((c) => c === u.searchParams.get("provider"));
      const s = p ? live(p)[0] : undefined;
      return s ? Response.json({ id: s.id, key: s.key }) : new Response("no slot", { status: 404 });
    }
    const slot = slotOf(req);
    const provider = slot?.provider ?? null;
    let headers = req.headers;
    let body: BodyInit | null = req.body;
    if (provider && freshSession.delete(provider) && req.body && req.method !== "GET") {
      // Claude Code's `/new`: a new session id on this request; account-bound ids stay as omp derived them.
      const text = await req.text();
      headers = new Headers(req.headers);
      body = refreshSession(provider, headers, text) ?? text;
      headers.delete("content-length");
    }
    const upstream = await o.router.fetch(new Request(`http://local${rest}${u.search}`, { method: req.method, headers, body, signal: req.signal, ...(body ? { duplex: "half" } : {}) } as RequestInit));
    const info = provider ? parseUpstream(upstream.headers.get(UPSTREAM_HEADER)) : null;
    if (provider && info) observe(provider, slot, info);
    const failed = upstream.status >= 400 && (upstream.status < 500 || info?.rotate === true);
    if (provider && slot && failed) {
      const text = await upstream.text();
      const rw = info ? usageLimitRewrite(provider, upstream.status, text, info) : null;
      if (rw) {
        const h = cleanHeaders(upstream.headers);
        h.set("content-type", "application/json");
        notifyRotation(slot, info!.reason === "none" ? "usage-limit" : info!.reason);
        return new Response(rw.body, { status: rw.status, headers: h });
      }
      if (isRotationNotice(provider, upstream.status, text)) notifyRotation(slot, "usage-limit");
      return new Response(text, { status: upstream.status, headers: cleanHeaders(upstream.headers) });
    }
    return new Response(upstream.body, { status: upstream.status, headers: cleanHeaders(upstream.headers) });
  }

  /** What NewAPI said about this response. Only observed: nothing here influences which channel serves the next one. */
  function observe(provider: Channel, slot: Slot | null, info: Upstream) {
    const ch = tracker.observe(provider, info);
    if (ch) for (const l of channelListeners) l({ provider, kind: "switched", from: ch.from ?? undefined, to: ch.to });
    if (info.refresh && info.channel !== undefined) for (const l of channelListeners) l({ provider, kind: "refreshed", to: info.channel });
    if (info.refresh || info.switched) freshSession.add(provider);
    if (info.rotate && slot) cooling.set(key(slot), now() + (info.retryAfterSec ?? DEFAULT_COOLDOWN_SEC) * 1000);
  }

  function notifyRotation(from: Slot, reason: string) {
    exhausted.add(key(from));
    const next = live(from.provider)[0];
    // The notice is relayed (omp rotates on it); this event only tells the UI which slot comes next.
    const ev: RotationEvent = { provider: from.provider, from: from.id, to: next?.id ?? "", reason: next ? reason : `${reason}; all slots exhausted` };
    for (const l of listeners) l(ev);
  }

  return {
    origin: () => CGSCONNECT_ORIGIN,
    pushCredentials(input: unknown) {
      if (!Array.isArray(input)) throw new Error("slots must be an array");
      const next = new Map<Channel, Slot[]>();
      for (const raw of input) {
        const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const provider = CHANNELS.find((c) => c === r.provider);
        if (!provider || typeof r.id !== "string" || typeof r.key !== "string") throw new Error("slot needs provider, id, key");
        const err = slotShapeError(provider, r.key);
        if (err) throw new Error(`slot ${r.id}: ${err}`);
        next.set(provider, [...(next.get(provider) ?? []), { provider, id: r.id, key: r.key }]);
      }
      slots.clear(); exhausted.clear(); cooling.clear();
      for (const [k, v] of next) slots.set(k, v);
    },
    onRotation: (cb) => void listeners.push(cb),
    onChannel: (cb) => void channelListeners.push(cb),
    lastChannel: (p) => tracker.lastChannel(p as Channel),
    manifest: (): ModelManifest => buildManifest(base, models, pricing),
    setModels(ids, p) { models = ids; if (p) pricing = p; },
    currentSlot: (p) => live(p)[0] ?? null,
    fetch: handle,
  };
}

function cleanHeaders(h: Headers): Headers {
  const out = new Headers(h);
  for (const k of HOP) out.delete(k);
  return out;
}
