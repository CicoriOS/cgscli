// Provider hub: serves omp's provider baseUrl in-process (model manifest, provider traffic through the router) and keeps
// the session identity epoch of each channel (ADR 0022). NewAPI alone chooses the upstream account; when its response
// says it moved on (`refresh`, `switched`, `rotate`), the client answers by looking like a new conversation: the next
// requests of that channel carry a new wire session id (omp patch P9 asks `sessionIdentity` for it).
import { createHash, randomBytes } from "node:crypto";
import { CGSCONNECT_ORIGIN, type ChannelEvent, type IdentityEvent, type ModelManifest, type ProviderHub, type Router } from "../contracts.ts";
import { buildManifest, CHANNEL_API, channelOfPath, type Channel, type SitePrice } from "./channels.ts";
import { ChannelTracker, parseUpstream, transientFailure, UPSTREAM_HEADER, type Upstream } from "./upstream.ts";

export interface ProviderHubOptions {
  router: Router;
  models?: string[];
  pricing?: Record<string, SitePrice>;
  /** Secret of this machine; `device_id` is derived from it. Random per process when omitted. */
  deviceSeed?: string;
}

export interface ProviderHubImpl extends ProviderHub {
  setModels(ids: string[], pricing?: Record<string, SitePrice>): void;
  /** Serves requests addressed to CGSCONNECT_ORIGIN (manifest, provider traffic); reached by direct call, never a socket. */
  fetch(req: Request): Promise<Response>;
}

const HOP = ["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"];

/** A UUID (v4 layout) derived from the conversation's session id, the channel and the epoch: stable within an epoch, different per conversation. */
function wireSessionId(sessionId: string, provider: string, epoch: number): string {
  const h = createHash("sha256").update(`${sessionId}\0${provider}\0${epoch}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Claude Code's `metadata.user_id` is a JSON string `{device_id, account_uuid, session_id}`; with an API key `account_uuid` is empty. */
function completeUserId(body: string, deviceId: string): string | undefined {
  let message: { metadata?: { user_id?: unknown } } | null;
  try { message = JSON.parse(body); } catch { return; }
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  let previous: Record<string, unknown> = {};
  const raw = message.metadata?.user_id;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) previous = parsed;
    } catch { /* not ours to interpret */ }
  }
  const userId = JSON.stringify({ device_id: deviceId, account_uuid: typeof previous.account_uuid === "string" ? previous.account_uuid : "", ...(typeof previous.session_id === "string" ? { session_id: previous.session_id } : {}) });
  message.metadata = { ...message.metadata, user_id: userId };
  return JSON.stringify(message);
}

export function createProviderHub(o: ProviderHubOptions): ProviderHubImpl {
  const seed = o.deviceSeed ?? randomBytes(32).toString("hex");
  const deviceId = (provider: string, epoch: number) => createHash("sha256").update(`${seed}\0${provider}\0${epoch}`).digest("hex");
  const epochs = new Map<string, number>();
  const identityListeners: ((e: IdentityEvent) => void)[] = [];
  const channelListeners: ((e: ChannelEvent) => void)[] = [];
  const tracker = new ChannelTracker();
  let models = o.models ?? [];
  let pricing = o.pricing ?? {};

  const base = CGSCONNECT_ORIGIN;
  const epochOf = (provider: string) => epochs.get(provider) ?? 0;

  /**
   * A new identity for `provider`. `startEpoch` is the epoch the signalling request was sent under: a signal from a
   * request that predates the latest switch is stale (several in-flight requests all hear the same news).
   */
  function switchIdentity(provider: Channel, reason: string, startEpoch: number) {
    if (epochOf(provider) !== startEpoch) return;
    const epoch = startEpoch + 1;
    epochs.set(provider, epoch);
    for (const l of identityListeners) l({ provider, epoch, reason });
  }

  /** What NewAPI said about this response. The channel is only observed; the identity switches on any "moved on" signal. */
  function observe(provider: Channel, info: Upstream, startEpoch: number) {
    const ch = tracker.observe(provider, info);
    if (ch) for (const l of channelListeners) l({ provider, kind: "switched", from: ch.from ?? undefined, to: ch.to });
    if (info.refresh && info.channel !== undefined) for (const l of channelListeners) l({ provider, kind: "refreshed", to: info.channel });
    if (info.rotate) switchIdentity(provider, info.reason === "none" ? "rotate" : `rotate: ${info.reason}`, startEpoch);
    else if (info.refresh) switchIdentity(provider, "refresh", startEpoch);
    else if (info.switched) switchIdentity(provider, "switched", startEpoch);
  }

  async function handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.origin !== CGSCONNECT_ORIGIN) return new Response("forbidden", { status: 403 });
    if (u.pathname === "/_cgsconnect/manifest") return Response.json(buildManifest(base, models, pricing));
    const target = channelOfPath(u.pathname);
    if (!target) return new Response("not found", { status: 404 });
    const { channel, rest } = target;
    const startEpoch = epochOf(channel);
    let body: BodyInit | null = req.body;
    if (req.method === "POST" && rest === "/v1/messages" && CHANNEL_API[channel].api === "anthropic-messages") {
      const text = await req.text();
      body = completeUserId(text, deviceId(channel, startEpoch)) ?? text;
    }
    const upstream = await o.router.fetch(new Request(`http://local${rest}${u.search}`, { method: req.method, headers: req.headers, body, signal: req.signal, ...(body ? { duplex: "half" } : {}) } as RequestInit));
    const info = parseUpstream(upstream.headers.get(UPSTREAM_HEADER));
    if (info) observe(channel, info, startEpoch);
    if (info?.rotate && upstream.status >= 400) {
      const failure = transientFailure(channel, upstream.status, await upstream.text(), info);
      if (failure) {
        const h = cleanHeaders(upstream.headers);
        h.set("content-type", "application/json");
        return new Response(failure.body, { status: failure.status, headers: h });
      }
    }
    return new Response(upstream.body, { status: upstream.status, headers: cleanHeaders(upstream.headers) });
  }

  return {
    origin: () => CGSCONNECT_ORIGIN,
    sessionIdentity(provider, sessionId) {
      const epoch = epochOf(provider);
      return epoch === 0 ? sessionId : wireSessionId(sessionId, provider, epoch);
    },
    onIdentity: (cb) => void identityListeners.push(cb),
    onChannel: (cb) => void channelListeners.push(cb),
    lastChannel: (p) => tracker.lastChannel(p as Channel),
    manifest: (): ModelManifest => buildManifest(base, models, pricing),
    setModels(ids, p) { models = ids; if (p) pricing = p; },
    fetch: handle,
  };
}

function cleanHeaders(h: Headers): Headers {
  const out = new Headers(h);
  for (const k of HOP) out.delete(k);
  return out;
}
