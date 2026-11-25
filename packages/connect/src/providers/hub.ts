// Provider hub: slot credentials, request handling for omp's provider baseUrl (handled in-process) and rotation notices.
import { CGSCONNECT_ORIGIN, type ModelManifest, type ProviderHub, type RotationEvent, type Router } from "../contracts.ts";
import { buildManifest, CHANNELS, isRotationNotice, slotSecret, slotShapeError, type Channel, type Slot, type SitePrice } from "./channels.ts";

export interface ProviderHubOptions {
  router: Router;
  models?: string[];
  pricing?: Record<string, SitePrice>;
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
  const slots = new Map<Channel, Slot[]>();
  const exhausted = new Set<string>();
  const listeners: ((e: RotationEvent) => void)[] = [];
  let models = o.models ?? [];
  let pricing = o.pricing ?? {};

  const base = CGSCONNECT_ORIGIN;

  const key = (s: Slot) => `${s.provider}/${s.id}`;
  const live = (p: Channel) => (slots.get(p) ?? []).filter((s) => !exhausted.has(key(s)));

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
    const upstream = await o.router.fetch(new Request(`http://local${rest}${u.search}`, { method: req.method, headers: req.headers, body: req.body, signal: req.signal, ...(req.body ? { duplex: "half" } : {}) } as RequestInit));
    const provider = slot?.provider ?? null;
    if (provider && slot && upstream.status >= 400 && upstream.status < 500) {
      const text = await upstream.text();
      if (isRotationNotice(provider, upstream.status, text)) notifyRotation(slot, "usage-limit");
      return new Response(text, { status: upstream.status, headers: cleanHeaders(upstream.headers) });
    }
    return new Response(upstream.body, { status: upstream.status, headers: cleanHeaders(upstream.headers) });
  }

  function notifyRotation(from: Slot, reason: string) {
    exhausted.add(key(from));
    const next = live(from.provider)[0];
    // The notice is relayed unchanged (omp rotates on it); this event only tells the UI which slot comes next.
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
      slots.clear(); exhausted.clear();
      for (const [k, v] of next) slots.set(k, v);
    },
    onRotation: (cb) => void listeners.push(cb),
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
