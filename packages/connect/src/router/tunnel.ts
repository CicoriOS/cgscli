// Relay tunnel client: WebSocket carrier + Noise_NK, exposed as a byte stream that HTTP/2 (cleartext) runs on
// (new-api tunnelkit/ws.go, noise.go; agent/route.go).
import { Duplex } from "node:stream";
import type { Endpoint } from "./bundle.ts";
import { MAX_MESSAGE, MAX_PLAINTEXT, noiseInitiator, type Transport } from "./noise.ts";

export const GATEWAY_PATH = "/api/tunnel/v1";
export const HEALTH_PATH = "/api/tunnel/health";
export const ORIGIN_HEADER = "X-CGS-Origin";
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface Target { endpoint: Endpoint; ip?: string }
export const targetKey = (t: Target) => `${t.endpoint.id}@${t.ip ?? "dns"}`;

/** Whole-message ordered carrier (a WebSocket). `read` rejects once the carrier is closed. */
export interface MessageConn {
  read(): Promise<Uint8Array>;
  write(msg: Uint8Array): void;
  close(): void;
}
/** Opens a carrier to a target; tests inject a local one. */
export type Carrier = (target: Target, signal: AbortSignal) => Promise<MessageConn>;

export class HandshakeError extends Error {}

/** Default carrier: WebSocket to the target IP (or resolved host) with Host/SNI = endpoint host; certificate not checked. */
export function defaultCarrierUrl(target: Target): string {
  const ep = target.endpoint;
  const addr = target.ip && target.ip.includes(":") ? `[${target.ip}]` : (target.ip ?? ep.host);
  return `${ep.tls ? "wss" : "ws"}://${addr}:${ep.port}${GATEWAY_PATH}`;
}

/** WebSocket carrier; `urlOf` lets tests point targets at a local gateway. */
export const makeWsCarrier = (urlOf: (t: Target) => string): Carrier => async (target, signal) => {
  const ep = target.endpoint;
  const url = urlOf(target);
  const ws = new WebSocket(url, { headers: { Host: `${ep.host}:${ep.port}` }, tls: { rejectUnauthorized: false, serverName: ep.host } } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const queue: Uint8Array[] = [];
  let pending: PromiseWithResolvers<Uint8Array> | null = null;
  let ended: Error | null = null;
  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const m = new Uint8Array(e.data);
    if (pending) { const p = pending; pending = null; p.resolve(m); } else queue.push(m);
  };
  const end = (err: Error) => { ended ??= err; if (pending) { const p = pending; pending = null; p.reject(ended); } };
  ws.onclose = () => end(new Error("tunnel carrier closed"));
  ws.onerror = () => end(new Error(`tunnel ${targetKey(target)}: carrier error`));
  const open = Promise.withResolvers<void>();
  ws.onopen = () => open.resolve();
  const abort = () => { ws.close(); end(new Error("aborted")); open.reject(new Error("aborted")); };
  signal.addEventListener("abort", abort, { once: true });
  ws.addEventListener("close", () => open.reject(new Error(`tunnel ${targetKey(target)}: upgrade failed`)));
  await open.promise;
  return {
    read() {
      const m = queue.shift();
      if (m) return Promise.resolve(m);
      if (ended) return Promise.reject(ended);
      pending = Promise.withResolvers<Uint8Array>();
      return pending.promise;
    },
    write: (m) => ws.send(m),
    close: () => { signal.removeEventListener("abort", abort); ws.close(); },
  };
};

export const wsCarrier: Carrier = makeWsCarrier(defaultCarrierUrl);

/** Encrypted byte stream over a MessageConn; each Noise message is one carrier message, in order. */
export class NoiseStream extends Duplex {
  constructor(private mc: MessageConn, private t: Transport) {
    super();
    void this.pump();
  }
  private async pump() {
    try {
      for (;;) {
        const msg = await this.mc.read();
        let plain: Uint8Array;
        try { plain = this.t.recv.decrypt(msg); } catch (e) { throw new Error(`tunnel record rejected: ${(e as Error).message}`); }
        if (plain.length) this.push(plain);
      }
    } catch (e) {
      if (this.destroyed) return;
      this.push(null);
      this.destroy();
    }
  }
  override _read() {}
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    try {
      for (let o = 0; o < chunk.length; o += MAX_PLAINTEXT) this.mc.write(this.t.send.encrypt(chunk.subarray(o, o + MAX_PLAINTEXT)));
      cb();
    } catch (e) { cb(e as Error); }
  }
  override _destroy(err: Error | null, cb: (e?: Error | null) => void) { this.mc.close(); cb(err); }
  // net.Socket surface that http2 touches
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}

export async function dialTunnel(target: Target, gatewayKeys: Uint8Array[], signal: AbortSignal, carrier: Carrier = wsCarrier): Promise<NoiseStream> {
  if (gatewayKeys.length === 0) throw new Error("no gateway key");
  let last: Error | null = null;
  // Keys are tried in order on fresh connections: a gateway that already dropped the first key still answers the next.
  for (const key of gatewayKeys) {
    const sig = AbortSignal.any([signal, AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS * 2)]);
    const mc = await carrier(target, sig);
    try {
      const hs = noiseInitiator(key);
      mc.write(hs.msg1);
      const timer = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
      const msg2 = await Promise.race([mc.read(), new Promise<never>((_, rej) => timer.addEventListener("abort", () => rej(new Error("handshake timeout"))))]);
      if (msg2.length > MAX_MESSAGE) throw new Error("oversized handshake message");
      return new NoiseStream(mc, hs.finish(msg2));
    } catch (e) {
      mc.close();
      last = new HandshakeError(`tunnel ${targetKey(target)}: ${(e as Error).message}`);
      if (signal.aborted) throw last;
    }
  }
  throw last ?? new Error("tunnel dial failed");
}
