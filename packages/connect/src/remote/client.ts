// Client (initiator) side of the remote link: dials the relay, runs the Noise handshake against a device and returns an
// end-to-end encrypted Duplex. This is what the CLI uses (`/cgs-remote connect`); a browser client does the same in JS.
import type { Duplex } from "@cgscli/wire";
import { ENVELOPE_VERSION, parseEnvelope } from "./envelope.ts";
import { Handshake, type KeyPair, type PatternName } from "./noise.ts";
import { SecureChannel } from "./link.ts";

export interface ConnectOptions {
  relayUrl: string;
  deviceId: string;
  /** The device's static key, from the pairing code. Required for IK; XX learns it in the handshake. */
  devicePub?: Uint8Array;
  pattern: PatternName;
  /** This client's own static key. */
  keys: KeyPair;
  /** Single-use pairing code; omit once the client key is paired. */
  pairingCode?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class RemoteRejected extends Error {
  constructor(readonly code: string) { super(`device refused the connection: ${code}`); }
}

export async function connectToDevice(o: ConnectOptions): Promise<Duplex> {
  const base = o.relayUrl.replace(/\/+$/, "");
  const ws = new WebSocket(`${base}/api/relay/client?device=${encodeURIComponent(o.deviceId)}`, { headers: o.headers ?? {} } as unknown as string[]);
  const timeout = o.timeoutMs ?? 10_000;

  let sid = "";
  let seq = 0;
  let chan: SecureChannel | null = null;
  const failure = Promise.withResolvers<never>();
  const opened = Promise.withResolvers<string>();
  const queue: Uint8Array[] = [];
  let waiter: ((ct: Uint8Array) => void) | null = null;

  ws.onmessage = (e) => {
    const env = typeof e.data === "string" ? parseEnvelope(e.data) : null;
    if (!env) return;
    if (env.type === "ctl") {
      if (env.payload.op === "open" && !sid) { sid = env.sid; opened.resolve(sid); }
      else if (env.payload.op === "error") { const r = new RemoteRejected(env.payload.code); failure.reject(r); chan?.finish(r); }
      else if (env.payload.op === "close") { failure.reject(new RemoteRejected("closed")); chan?.finish(); }
      return;
    }
    const ct = Uint8Array.from(Buffer.from(env.payload, "base64"));
    if (chan) chan.receive(ct);
    else if (waiter) { const w = waiter; waiter = null; w(ct); }
    else queue.push(ct);
  };
  ws.onclose = () => { failure.reject(new RemoteRejected("closed")); chan?.finish(); };
  failure.promise.catch(() => {}); // surfaced through the races below; never an unhandled rejection

  const timer = setTimeout(() => failure.reject(new Error(`relay handshake timed out after ${timeout} ms`)), timeout);
  try {
    await Promise.race([new Promise<void>((r, j) => { ws.onopen = () => r(); ws.addEventListener("error", () => j(new Error("could not reach the relay"))); }), failure.promise]);
    await Promise.race([opened.promise, failure.promise]);
    const send = (b: Uint8Array) => ws.send(JSON.stringify({ v: ENVELOPE_VERSION, type: "data", sid, seq: seq++, payload: Buffer.from(b).toString("base64") }));
    const next = () => Promise.race([new Promise<Uint8Array>((r) => { const q = queue.shift(); if (q) r(q); else waiter = r; }), failure.promise]);

    const hs = new Handshake({ pattern: o.pattern, initiator: true, s: o.keys, rs: o.pattern === "IK" ? o.devicePub : undefined });
    const payload = new TextEncoder().encode(JSON.stringify(o.pairingCode ? { pair: o.pairingCode } : {}));
    if (o.pattern === "XX") {
      send(hs.write());
      hs.read(await next());
      send(hs.write(payload));
    } else {
      if (!o.devicePub) throw new Error("IK needs the device's public key");
      send(hs.write(payload));
      hs.read(await next());
    }
    chan = new SecureChannel(hs.split(), send, () => ws.close());
    return chan;
  } catch (e) {
    ws.close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
