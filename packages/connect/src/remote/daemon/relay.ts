// Device side of the relay (`WS /relay`; ADR 0036 §4 and §8, cgsconnect/relay-protocol.md). The device dials out with its
// client credential, keeps the link up with capped exponential backoff, and multiplexes sessions by sid. The relay only
// sees envelopes; `data` payloads are end-to-end Noise messages that this module never inspects.
import { ENVELOPE_VERSION, parseEnvelope, type CtlBody } from "../envelope.ts";

export interface RelayAccount {
  baseUrl: string;
  clientSecret: string;
  /** http(s) proxy for the relay WebSocket and the API calls, when the network needs one. */
  proxy?: string;
}

export interface RelayCallbacks {
  open(sid: string): void;
  data(sid: string, bytes: Uint8Array): void;
  close(sid: string): void;
  disconnected(code: number): void;
}

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const REMOTE_API_TIMEOUT_MS = 15_000;
const CLOSE_ABNORMAL = 1006;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Delay before reconnect attempt `attempt` (0-based): 1 s, 2 s, 4 s, ... capped at 30 s.
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_CAP_MS, RECONNECT_INITIAL_MS * 2 ** attempt);
}

// `path` under `baseUrl`. Only https, or http to a loopback host, is allowed; credentials in the URL are refused.
// Errors carry fixed codes only, never the URL.
function endpoint(baseUrl: string, path: string): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error("relay_url_invalid");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))) throw new Error("relay_url_insecure");
  if (u.username || u.password) throw new Error("relay_url_credentials");
  u.pathname = `${u.pathname.replace(/\/+$/, "")}${path}`;
  u.search = "";
  u.hash = "";
  return u;
}

function bearer(clientSecret: string): string {
  if (!clientSecret) throw new Error("client_secret_missing");
  return `Bearer ${clientSecret}`;
}

export class DeviceRelay {
  readonly #url: string;
  readonly #auth: string;
  readonly #proxy: string | undefined;
  readonly #cb: RelayCallbacks;
  #ws: WebSocket | null = null;
  // Bumped for every new socket and every invalidation. Handlers of any other socket see a mismatch and do nothing.
  #gen = 0;
  #running = false;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  // Live sessions: sid -> next outbound seq. Each sender numbers its own frames per sid; ctl and data share the counter.
  readonly #sessions = new Map<string, number>();

  constructor(account: RelayAccount, callbacks: RelayCallbacks) {
    const u = endpoint(account.baseUrl, "/relay");
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    this.#url = u.href;
    this.#auth = bearer(account.clientSecret);
    this.#proxy = account.proxy;
    this.#cb = callbacks;
  }

  get online(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#connect();
  }

  // Ends the link for good: live sessions are closed (ctl close sent, callbacks fired), no reconnect is scheduled, and
  // any frame still arriving from the old socket is ignored.
  stop(): void {
    this.#running = false;
    this.#gen++;
    this.#clearTimer();
    this.#attempt = 0;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        for (const [sid, seq] of this.#sessions) {
          ws.send(JSON.stringify({ v: ENVELOPE_VERSION, type: "ctl", sid, seq, payload: { op: "close", reason: "stopped" } }));
        }
      }
      ws.close(1000);
    }
    this.#endSessions();
  }

  // Dropped silently when the link is down or the sid has no live session: that session is already gone.
  send(sid: string, bytes: Uint8Array): void {
    const ws = this.#ws;
    const seq = this.#sessions.get(sid);
    if (!ws || ws.readyState !== WebSocket.OPEN || seq === undefined) return;
    this.#sessions.set(sid, seq + 1);
    const payload = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    ws.send(JSON.stringify({ v: ENVELOPE_VERSION, type: "data", sid, seq, payload }));
  }

  // Ends session `sid` from this side: the relay is told, and the callback is not fired (the caller already knows).
  hangup(sid: string): void {
    const ws = this.#ws;
    const seq = this.#sessions.get(sid);
    if (seq === undefined) return;
    this.#sessions.delete(sid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ v: ENVELOPE_VERSION, type: "ctl", sid, seq, payload: { op: "close", reason: "hangup" } }));
    }
  }

  #connect(): void {
    const gen = ++this.#gen;
    const ws = new WebSocket(this.#url, { headers: { Authorization: this.#auth }, ...(this.#proxy ? { proxy: this.#proxy } : {}) });
    this.#ws = ws;
    ws.onopen = () => {
      if (gen === this.#gen) this.#attempt = 0;
    };
    ws.onmessage = (e) => {
      if (gen === this.#gen) this.#receive(e.data);
    };
    ws.onerror = () => this.#lost(gen, CLOSE_ABNORMAL);
    ws.onclose = (e) => this.#lost(gen, e.code);
  }

  // Called once per socket: the first of error/close wins, the other is stale and ignored.
  #lost(gen: number, code: number): void {
    if (gen !== this.#gen) return;
    this.#gen++;
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
    this.#endSessions();
    this.#cb.disconnected(code);
    if (this.#running && this.#ws === null && this.#timer === null) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const delay = reconnectDelayMs(this.#attempt++);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#running) this.#connect();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;
    const env = parseEnvelope(data);
    if (!env) return;
    if (env.type === "data") {
      if (!this.#sessions.has(env.sid)) return;
      const buf = Buffer.from(env.payload, "base64");
      this.#cb.data(env.sid, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      return;
    }
    this.#control(env.sid, env.payload);
  }

  #control(sid: string, body: CtlBody): void {
    if (body.op === "open") {
      if (this.#sessions.has(sid)) return;
      this.#sessions.set(sid, 0);
      this.#cb.open(sid);
      return;
    }
    // `close`, and `error` for a sid, both end that session.
    if (this.#sessions.delete(sid)) this.#cb.close(sid);
  }

  #endSessions(): void {
    const sids = [...this.#sessions.keys()];
    this.#sessions.clear();
    for (const sid of sids) this.#cb.close(sid);
  }
}

// Device-side remote switch (ADR 0036 §2, §4): GET reads `{allowed, enabled}`; PUT with `enabled` sets it.
// Redirects are not followed, so the credential never leaves the origin it was sent to.
export async function remoteApi(account: RelayAccount, enabled?: boolean): Promise<{ allowed: boolean; enabled: boolean }> {
  const url = endpoint(account.baseUrl, "/api/device/remote");
  const body = enabled === undefined ? undefined : JSON.stringify({ enabled });
  const headers: Record<string, string> = { Accept: "application/json", Authorization: bearer(account.clientSecret) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? "GET" : "PUT",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REMOTE_API_TIMEOUT_MS),
      ...(account.proxy ? { proxy: account.proxy } : {}),
    });
  } catch {
    throw new Error("remote_api_unreachable");
  }
  const text = await res.text().catch(() => {
    throw new Error("remote_api_unreachable");
  });
  if (res.status === 403 && text.includes("remote_not_allowed")) throw new Error("remote_not_allowed");
  if (!res.ok) throw new Error(`remote_api_http_${res.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("remote_api_bad_response");
  }
  // The server wraps its answer: { success, data: { allowed, enabled } }.
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!isRemoteState(data)) throw new Error("remote_api_bad_response");
  return { allowed: data.allowed, enabled: data.enabled };
}

function isRemoteState(v: unknown): v is { allowed: boolean; enabled: boolean } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.allowed === "boolean" && typeof o.enabled === "boolean";
}
