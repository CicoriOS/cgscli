// Signed tunnel configuration: root key -> issuer certificate -> config (new-api tunnelkit/sign.go, config.go).
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_ISSUER_VALIDITY_MS = 90 * 24 * 3600 * 1000;
export const MAX_ENDPOINTS = 16;
export const MAX_ENDPOINT_IPS = 64;
export const MAX_GATEWAY_KEYS = 4;
const SIGN_CONTEXT = "cgs-tunnel-signed/v1\0";

/** Public halves of the production offline root keys (tunnelkit/roots.go: root-current, root-next). */
export const PRODUCTION_ROOT_KEYS = [
  "13af7964a5cb95a54621c6c9364ea54f38ba942688c9d06d359acc306d37c33d",
  "cf07acbb677435063212135308e54635abd6744b014a8bfd7fd4c2783a3aef3d",
];

export interface IPEntry { ip: string; label?: string; weight?: number }
export interface Endpoint { id: string; label?: string; host: string; port: number; tls: boolean; priority?: number; ips?: IPEntry[] }
export interface TunnelConfig { version: number; issued_at: number; expires_at: number; gateway_keys: Uint8Array[]; endpoints: Endpoint[] }
interface Envelope { type: string; key_id: string; body: Uint8Array; sig: Uint8Array }
interface IssuerCert { key_id: string; public_key: Uint8Array; not_before: number; not_after: number }

export type Roots = Map<string, Uint8Array>;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const keyId = (pub: Uint8Array): string => hex(sha256(pub).subarray(0, 8));

export function rootsFromHex(keys: string[]): Roots {
  const m: Roots = new Map();
  for (const h of keys) {
    const pub = Uint8Array.from(Buffer.from(h, "hex"));
    if (pub.length !== 32) throw new Error("root key must be an Ed25519 public key");
    m.set(keyId(pub), pub);
  }
  return m;
}

function signingInput(type: string, body: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(SIGN_CONTEXT + type + "\0"), body]);
}

/** Go encodes []byte as base64 in JSON. */
function b64(v: unknown, what: string): Uint8Array {
  if (typeof v !== "string") throw new Error(`${what}: expected base64 string`);
  return Uint8Array.from(Buffer.from(v, "base64"));
}

function envelope(v: unknown, what: string): Envelope {
  if (!v || typeof v !== "object") throw new Error(`${what}: not an object`);
  const o = v as Record<string, unknown>;
  if (typeof o.type !== "string" || typeof o.key_id !== "string") throw new Error(`${what}: malformed envelope`);
  return { type: o.type, key_id: o.key_id, body: b64(o.body, what), sig: b64(o.sig, what) };
}

function verifyEnvelope(e: Envelope, type: string, pub: Uint8Array) {
  if (e.type !== type) throw new Error(`envelope type "${e.type}", want "${type}"`);
  if (e.key_id !== keyId(pub)) throw new Error("envelope key id does not match the verifying key");
  if (e.sig.length !== 64 || !ed25519.verify(e.sig, signingInput(type, e.body), pub)) throw new Error("envelope signature is invalid");
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function parseIp(s: string): { v4: number[] | null; v6: bigint | null } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) {
    const o = m.slice(1).map(Number);
    return o.every((x) => x <= 255) ? { v4: o, v6: null } : null;
  }
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":") || s.includes("%")) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return parseIp(mapped[1]!);
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const side = (x: string) => (x === "" ? [] : x.split(":"));
  const head = side(halves[0]!), tail = halves.length === 2 ? side(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return { v4: null, v6: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

const in4 = (o: number[], a: number, b: number, c: number, d: number, bits: number) => {
  const x = ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
  const y = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (x & mask) === (y & mask);
};

/** tunnelkit PublicIP: global unicast, not private/shared, and (unless allowTestNets) not documentation ranges. */
export function publicIp(s: string, allowTestNets: boolean): boolean {
  const ip = parseIp(s);
  if (!ip) return false;
  if (ip.v4) {
    const o = ip.v4;
    if (o[0] === 0 || o[0] === 127 || o[0]! >= 224 || (o[0] === 169 && o[1] === 254)) return false;
    if (in4(o, 10, 0, 0, 0, 8) || in4(o, 172, 16, 0, 0, 12) || in4(o, 192, 168, 0, 0, 16) || in4(o, 100, 64, 0, 0, 10)) return false;
    if (in4(o, 255, 255, 255, 255, 32)) return false;
    if (in4(o, 192, 0, 2, 0, 24) || in4(o, 198, 51, 100, 0, 24) || in4(o, 203, 0, 113, 0, 24)) return allowTestNets;
    return true;
  }
  const v = ip.v6!;
  const top = Number(v >> 112n);
  if (v === 0n || v === 1n) return false;
  if ((top & 0xe000) !== 0x2000) return false; // global unicast 2000::/3
  if (v >> 96n === 0x20010db8n) return allowTestNets;
  return true;
}

export function validHost(h: string): boolean {
  if (h.length === 0 || h.length > 253 || h !== h.toLowerCase() || parseIp(h)) return false;
  const labels = h.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL_RE.test(l));
}

export function validateEndpoints(eps: Endpoint[], allowTestNets: boolean) {
  if (eps.length > MAX_ENDPOINTS) throw new Error(`at most ${MAX_ENDPOINTS} endpoints`);
  const ids = new Set<string>();
  for (const ep of eps) {
    if (!ID_RE.test(ep.id)) throw new Error(`invalid endpoint id "${ep.id}"`);
    if (ids.has(ep.id)) throw new Error(`duplicate endpoint id "${ep.id}"`);
    ids.add(ep.id);
    if ((ep.label?.length ?? 0) > 64) throw new Error(`endpoint ${ep.id}: label too long`);
    if (!validHost(ep.host)) throw new Error(`endpoint ${ep.id}: host must be a lowercase domain name, got "${ep.host}"`);
    if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) throw new Error(`endpoint ${ep.id}: invalid port ${ep.port}`);
    const prio = ep.priority ?? 0;
    if (prio < -1000 || prio > 1000) throw new Error(`endpoint ${ep.id}: priority must be within +-1000`);
    const ips = ep.ips ?? [];
    if (ips.length > MAX_ENDPOINT_IPS) throw new Error(`endpoint ${ep.id}: at most ${MAX_ENDPOINT_IPS} IPs`);
    const seen = new Set<string>();
    for (const e of ips) {
      if (!publicIp(e.ip, allowTestNets)) throw new Error(`endpoint ${ep.id}: ${e.ip} is not a public unicast address`);
      if (seen.has(e.ip)) throw new Error(`endpoint ${ep.id}: duplicate IP ${e.ip}`);
      seen.add(e.ip);
      if ((e.label?.length ?? 0) > 64) throw new Error(`endpoint ${ep.id}: IP label too long`);
      const w = e.weight ?? 0;
      if (w < 0 || w > 100) throw new Error(`endpoint ${ep.id}: IP weight must be within 0..100`);
    }
  }
}

export interface VerifyOptions { roots: Roots; now?: number; allowTestNets?: boolean }

/** Verify chain root -> issuer cert -> config at `now`; accepts the bundle as served by the API (JSON object or string). */
export function verifyBundle(raw: unknown, o: VerifyOptions): TunnelConfig {
  const bundle = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!bundle || typeof bundle !== "object") throw new Error("bundle: not an object");
  const b = bundle as Record<string, unknown>;
  const certEnv = envelope(b.issuer_cert, "issuer certificate");
  const cfgEnv = envelope(b.config, "tunnel config");

  const root = o.roots.get(certEnv.key_id);
  if (!root) throw new Error("issuer certificate is signed by an unknown root");
  try { verifyEnvelope(certEnv, "issuer_cert", root); } catch (e) { throw new Error(`issuer certificate: ${(e as Error).message}`); }
  const c = JSON.parse(Buffer.from(certEnv.body).toString()) as Record<string, unknown>;
  const cert: IssuerCert = { key_id: String(c.key_id), public_key: b64(c.public_key, "issuer certificate"), not_before: Number(c.not_before), not_after: Number(c.not_after) };
  if (cert.public_key.length !== 32 || cert.key_id !== keyId(cert.public_key)) throw new Error("issuer certificate carries an invalid key");
  if (!(cert.not_after > cert.not_before) || cert.not_after - cert.not_before > MAX_ISSUER_VALIDITY_MS) throw new Error("issuer certificate has an invalid validity window");

  const now = o.now ?? Date.now();
  if (now + CLOCK_SKEW_MS < cert.not_before || now - CLOCK_SKEW_MS >= cert.not_after) throw new Error("issuer certificate is expired or not yet valid");
  try { verifyEnvelope(cfgEnv, "tunnel_config", cert.public_key); } catch (e) { throw new Error(`tunnel config: ${(e as Error).message}`); }

  const j = JSON.parse(Buffer.from(cfgEnv.body).toString()) as Record<string, unknown>;
  const keys = Array.isArray(j.gateway_keys) ? j.gateway_keys.map((k) => b64(k, "gateway key")) : [];
  const cfg: TunnelConfig = {
    version: Number(j.version), issued_at: Number(j.issued_at), expires_at: Number(j.expires_at),
    gateway_keys: keys, endpoints: (Array.isArray(j.endpoints) ? j.endpoints : []) as Endpoint[],
  };
  if (cfg.issued_at < cert.not_before || cfg.issued_at >= cert.not_after || cfg.expires_at > cert.not_after || cfg.expires_at <= cfg.issued_at) throw new Error("tunnel config lies outside its issuer certificate");
  if (now + CLOCK_SKEW_MS < cfg.issued_at || now - CLOCK_SKEW_MS >= cfg.expires_at) throw new Error("tunnel config is expired or not yet valid");
  if (keys.length === 0 || keys.length > MAX_GATEWAY_KEYS) throw new Error("tunnel config has no usable gateway key");
  if (keys.some((k) => k.length !== 32)) throw new Error("tunnel config has a malformed gateway key");
  try { validateEndpoints(cfg.endpoints, o.allowTestNets ?? false); } catch (e) { throw new Error(`tunnel config: ${(e as Error).message}`); }
  return cfg;
}

/** Test/tooling helper mirroring tunnelkit Seal. */
export function seal(type: string, priv: Uint8Array, body: Uint8Array): { type: string; key_id: string; body: string; sig: string } {
  const pub = ed25519.getPublicKey(priv);
  return { type, key_id: keyId(pub), body: Buffer.from(body).toString("base64"), sig: Buffer.from(ed25519.sign(signingInput(type, body), priv)).toString("base64") };
}
