// Device login (port of legacy src/cgs/device-flow.js + pow.js): create session -> proof of work -> verification
// link -> poll until approved. Server API: new-api /api/device/sessions.
import { createHash } from "node:crypto";
import os from "node:os";

export interface DeviceLoginResult { clientSecret: string; tier: string; username: string }
export type LoginProgress =
  | { phase: "creating" | "solving" }
  | { phase: "waiting"; verificationUrl: string; expiresAt: number };

export class LoginError extends Error {
  constructor(readonly code: "network" | "rate_limited" | "server" | "bad_response" | "rejected" | "challenge_failed" | "denied" | "expired" | "aborted", message: string) { super(message); }
}

const TRANSIENT: Record<string, true> = { network: true, rate_limited: true, server: true };
const MAX_POLL_FAILURES = 5;

function leadingZeroBits(d: Uint8Array, bits: number): boolean {
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (d[i] !== 0) return false;
  const rem = bits & 7;
  return rem === 0 || (d[full]! >> (8 - rem)) === 0;
}

/** Smallest decimal nonce with sha256(prefix + ":" + nonce) having `difficulty` leading zero bits. Yields between chunks. */
export async function solvePow(prefix: string, difficulty: number, signal?: AbortSignal, chunk = 20_000): Promise<string> {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) throw new TypeError("invalid proof-of-work challenge");
  for (let start = 0; ; start += chunk) {
    if (signal?.aborted) throw new LoginError("aborted", "cancelled");
    for (let n = start; n < start + chunk; n++) {
      if (leadingZeroBits(createHash("sha256").update(`${prefix}:${n}`).digest(), difficulty)) return String(n);
    }
    await new Promise<void>((r) => setImmediate(r));
  }
}

async function call(f: typeof fetch, base: string, method: string, p: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(`${base.replace(/\/+$/, "")}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]) });
  } catch (e) {
    if (signal?.aborted) throw new LoginError("aborted", "cancelled");
    throw new LoginError("network", `cannot reach the server: ${e instanceof Error ? e.message : e}`);
  }
  if (res.status === 429) throw new LoginError("rate_limited", "too many requests, try again later");
  if (res.status >= 500) throw new LoginError("server", `server unavailable (HTTP ${res.status})`);
  const env: unknown = await res.json().catch(() => null);
  const o = env && typeof env === "object" ? (env as Record<string, unknown>) : null;
  if (!o || typeof o.success !== "boolean") throw new LoginError("bad_response", "unrecognised server response");
  if (!o.success) throw new LoginError("rejected", `server rejected the request${o.message ? `: ${o.message}` : ""}`);
  return o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : {};
}

export interface DeviceLoginOptions {
  baseUrl: string;
  appVersion?: string;
  deviceName?: string;
  platform?: string;
  signal?: AbortSignal;
  onProgress?(p: LoginProgress): void;
  pollIntervalMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new LoginError("aborted", "cancelled"));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new LoginError("aborted", "cancelled")); }, { once: true });
});

export async function deviceLogin(o: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const interval = o.pollIntervalMs ?? 2000;
  o.onProgress?.({ phase: "creating" });
  const s = await call(f, o.baseUrl, "POST", "/api/device/sessions", {
    device_name: (o.deviceName ?? os.hostname() ?? "unknown").slice(0, 64), platform: (o.platform ?? `${os.type()} ${os.release()}`).slice(0, 64), app_version: (o.appVersion ?? "0.0.0").slice(0, 32),
  }, o.signal);
  const ch = s.challenge as { prefix?: unknown; difficulty?: unknown; algorithm?: unknown } | undefined;
  if (typeof s.session_id !== "string" || !s.session_id || !ch || typeof ch.prefix !== "string" || !Number.isInteger(ch.difficulty) || (ch.algorithm && ch.algorithm !== "sha256")) throw new LoginError("bad_response", "unrecognised security challenge");

  o.onProgress?.({ phase: "solving" });
  const nonce = await solvePow(ch.prefix, ch.difficulty as number, o.signal);
  let link: Record<string, unknown>;
  try { link = await call(f, o.baseUrl, "POST", `/api/device/sessions/${encodeURIComponent(s.session_id)}/challenge`, { nonce }, o.signal); }
  catch (e) { throw e instanceof LoginError && e.code === "rejected" ? new LoginError("challenge_failed", "security check failed or expired") : e; }
  if (typeof link.uuid !== "string" || typeof link.poll_token !== "string" || typeof link.verification_url !== "string") throw new LoginError("bad_response", "unrecognised login session");
  // The server builds the link from its own configured host; keep path/query on the host we talk to.
  const u = new URL(link.verification_url);
  const verificationUrl = `${o.baseUrl.replace(/\/+$/, "")}${u.pathname}${u.search}${u.hash}`;
  const expiresAt = Number(link.expires_at) * 1000;
  o.onProgress?.({ phase: "waiting", verificationUrl, expiresAt });

  let failures = 0;
  for (;;) {
    await sleep(interval, o.signal);
    if (now() > expiresAt + interval) throw new LoginError("expired", "login link expired");
    let d: Record<string, unknown>;
    try {
      d = await call(f, o.baseUrl, "POST", `/api/device/sessions/${encodeURIComponent(link.uuid)}/poll`, { poll_token: link.poll_token }, o.signal);
      failures = 0;
    } catch (e) {
      if (e instanceof LoginError && e.code === "rejected") throw new LoginError("expired", "login link expired");
      if (e instanceof LoginError && e.code in TRANSIENT && ++failures < MAX_POLL_FAILURES) continue;
      throw e;
    }
    if (d.status === "approved") {
      if (typeof d.client_secret !== "string" || !d.client_secret) throw new LoginError("bad_response", "unrecognised login result");
      return { clientSecret: d.client_secret, tier: typeof d.tier === "string" ? d.tier : "free", username: typeof d.username === "string" ? d.username : "" };
    }
    if (d.status === "denied") throw new LoginError("denied", "login request was denied");
    if (d.status === "expired") throw new LoginError("expired", "login link expired");
    if (d.status !== "pending") throw new LoginError("bad_response", "unrecognised login status");
  }
}
