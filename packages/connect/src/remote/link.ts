// RemoteLink: outbound WebSocket to the relay; one end-to-end Noise session per client `sid`; the relay sees only
// envelopes and ciphertext (docs: cgsconnect/remote.md, relay-protocol.md, ADR 0006).
import type { Duplex, Msg } from "@cgscli/wire";
import type { RemoteLink } from "../contracts.ts";
import { ENVELOPE_VERSION, parseEnvelope, type CtlBody, type Envelope } from "./envelope.ts";
import { fingerprint, IdentityStore, PairingCodes } from "./identity.ts";
import { Handshake, type PatternName } from "./noise.ts";
import type { Transport } from "../router/noise.ts";

const CHUNK = 65535 - 16 - 1; // Noise max message - tag - 1 flag byte
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface RemoteLinkOptions {
  /** e.g. wss://ai.example.com ; endpoints per relay-protocol.md. */
  relayUrl: string;
  /** Noise pattern: undecided product-wise, so required. */
  pattern: PatternName;
  identityFile: string;
  /** Account credential for device registration and the device socket. */
  clientSecret(): string | null;
  /** Asks the user on the device to confirm a new client; absent means a valid pairing code is enough. */
  approve?(clientFingerprint: string): Promise<boolean>;
  fetch?: typeof fetch;
  deviceName?: string;
  backoffMs?: { initial: number; max: number };
  log?: (m: string) => void;
}

/** Splits one JSON message into Noise records (flag 1 = more follows, 0 = last) and reassembles on the other side. */
export class SecureChannel implements Duplex {
  private onMsg: ((m: Msg) => void)[] = [];
  private onCls: ((e?: Error) => void)[] = [];
  private parts: Uint8Array[] = [];
  private size = 0;
  private closed = false;
  constructor(private t: Transport, private write: (ct: Uint8Array) => void, private doClose: () => void) {}

  send(m: Msg) {
    if (this.closed) throw new Error("closed");
    const bytes = new TextEncoder().encode(JSON.stringify(m));
    for (let o = 0; o === 0 || o < bytes.length; o += CHUNK) {
      const chunk = bytes.subarray(o, o + CHUNK);
      const rec = new Uint8Array(chunk.length + 1);
      rec[0] = o + CHUNK < bytes.length ? 1 : 0;
      rec.set(chunk, 1);
      this.write(this.t.send.encrypt(rec));
    }
  }

  /** Feed one ciphertext record; a record that fails authentication ends the session (nonce stream is lost). */
  receive(ct: Uint8Array) {
    let rec: Uint8Array;
    try { rec = this.t.recv.decrypt(ct); } catch (e) { this.fail(new Error("record rejected")); return; }
    this.size += rec.length - 1;
    if (this.size > MAX_MESSAGE_BYTES) return this.fail(new Error("message too large"));
    this.parts.push(rec.subarray(1));
    if (rec[0] === 1) return;
    const full = Buffer.concat(this.parts);
    this.parts = []; this.size = 0;
    let m: unknown;
    try { m = JSON.parse(full.toString()); } catch { return this.fail(new Error("malformed message")); }
    if (m && typeof m === "object" && typeof (m as Msg).t === "string") for (const f of this.onMsg) f(m as Msg);
  }

  private fail(e: Error) { this.finish(e); this.doClose(); }
  finish(e?: Error) { if (this.closed) return; this.closed = true; for (const f of this.onCls) f(e); }
  onMessage(cb: (m: Msg) => void) { this.onMsg.push(cb); }
  onClose(cb: (e?: Error) => void) { this.onCls.push(cb); }
  close() { this.finish(); this.doClose(); }
}

interface Peer { hs: Handshake; authorized: boolean; chan: SecureChannel | null; seq: number }

export function createRemoteLink(o: RemoteLinkOptions): RemoteLink & { fingerprint(): string; deviceId(): string } {
  const store = new IdentityStore(o.identityFile);
  const codes = new PairingCodes();
  const doFetch = o.fetch ?? fetch;
  const log = o.log ?? (() => {});
  const backoff = o.backoffMs ?? { initial: 1000, max: 30_000 };
  const base = o.relayUrl.replace(/\/+$/, "");
  const http = base.replace(/^ws/, "http");
  const acceptors: ((d: Duplex) => void)[] = [];
  const peers = new Map<string, Peer>();
  let ws: WebSocket | null = null;
  let stopped = true;
  let delay = backoff.initial;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let upSeq = 0;

  const auth = (): Record<string, string> => {
    const k = o.clientSecret();
    if (!k) throw new Error("not logged in");
    return { Authorization: `Bearer ${k}` };
  };

  function sendEnv(e: Envelope) { ws?.send(JSON.stringify(e)); }
  const ctl = (sid: string, p: CtlBody) => sendEnv({ v: ENVELOPE_VERSION, type: "ctl", sid, seq: upSeq++, payload: p });

  function dropPeer(sid: string, notify: boolean) {
    const p = peers.get(sid);
    if (!p) return;
    peers.delete(sid);
    p.chan?.finish();
    if (notify) ctl(sid, { op: "close" });
  }

  async function authorize(p: Peer, payload: Uint8Array): Promise<boolean> {
    const rs = p.hs.remoteStatic!;
    if (store.isPaired(rs)) return true;
    let code = "";
    try { const j: unknown = JSON.parse(Buffer.from(payload).toString()); code = j && typeof j === "object" && typeof (j as { pair?: unknown }).pair === "string" ? (j as { pair: string }).pair : ""; } catch { /* no code */ }
    if (!code || !codes.consume(code)) return false;
    if (o.approve && !(await o.approve(fingerprint(rs)))) return false;
    store.addPaired(rs);
    return true;
  }

  async function onData(env: Extract<Envelope, { type: "data" }>) {
    const p = peers.get(env.sid);
    if (!p) return;
    const ct = Uint8Array.from(Buffer.from(env.payload, "base64"));
    try {
      if (p.chan) return p.chan.receive(ct);
      const payload = p.hs.read(ct);
      // The client's static key is known once its `s` has been read: authorize before answering or finishing.
      if (p.hs.remoteStatic && !p.authorized) {
        if (!(await authorize(p, payload))) { log(`sid ${env.sid}: client not paired`); ctl(env.sid, { op: "error", code: "unpaired" }); return dropPeer(env.sid, true); }
        p.authorized = true;
      }
      if (!p.hs.done) sendEnv({ v: ENVELOPE_VERSION, type: "data", sid: env.sid, seq: p.seq++, payload: Buffer.from(p.hs.write()).toString("base64") });
      if (p.hs.done) {
        const sid = env.sid;
        p.chan = new SecureChannel(p.hs.split(), (c) => sendEnv({ v: ENVELOPE_VERSION, type: "data", sid, seq: p.seq++, payload: Buffer.from(c).toString("base64") }), () => dropPeer(sid, true));
        for (const a of acceptors) a(p.chan);
      }
    } catch (e) {
      log(`sid ${env.sid}: ${e instanceof Error ? e.message : e}`);
      dropPeer(env.sid, true);
    }
  }

  function onEnvelope(env: Envelope) {
    if (env.type === "ctl") {
      if (env.payload.op === "open") peers.set(env.sid, { hs: new Handshake({ pattern: o.pattern, initiator: false, s: store.identity.keys }), authorized: false, chan: null, seq: 0 });
      else if (env.payload.op === "close" || env.payload.op === "error") dropPeer(env.sid, false);
      return;
    }
    void onData(env);
  }

  function connect(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    const sock = new WebSocket(`${base}/api/relay/device?device=${store.identity.deviceId}`, { headers: auth() } as unknown as string[]);
    ws = sock;
    sock.onopen = () => { delay = backoff.initial; opened.resolve(); };
    sock.onmessage = (e) => { const env = typeof e.data === "string" ? parseEnvelope(e.data) : null; if (env) onEnvelope(env); };
    sock.onclose = () => {
      opened.reject(new Error("relay connection closed"));
      for (const sid of [...peers.keys()]) dropPeer(sid, false);
      if (stopped || ws !== sock) return;
      retry = setTimeout(() => { connect().catch(() => {}); }, delay);
      delay = Math.min(delay * 2, backoff.max);
    };
    sock.onerror = () => {};
    return opened.promise;
  }

  return {
    fingerprint: () => fingerprint(store.identity.keys.pub),
    deviceId: () => store.identity.deviceId,
    async start() {
      const r = await doFetch(`${http}/api/devices`, {
        method: "POST", headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ id: store.identity.deviceId, name: o.deviceName ?? "", public_key: Buffer.from(store.identity.keys.pub).toString("hex") }),
      });
      if (!r.ok) throw new Error(`device registration failed: HTTP ${r.status}`);
      stopped = false;
      await connect();
    },
    async stop() {
      stopped = true;
      clearTimeout(retry ?? undefined);
      for (const sid of [...peers.keys()]) dropPeer(sid, false);
      ws?.close();
      ws = null;
    },
    async pairing() { return codes.issue(); },
    async devices() {
      const r = await doFetch(`${http}/api/devices`, { headers: auth() });
      if (!r.ok) throw new Error(`device list failed: HTTP ${r.status}`);
      const j: unknown = await r.json();
      const list = Array.isArray(j) ? j : (j && typeof j === "object" && Array.isArray((j as { data?: unknown }).data) ? (j as { data: unknown[] }).data : []);
      return list.map((d) => { const x = d as { id?: unknown; name?: unknown; online?: unknown }; return { id: String(x.id), name: String(x.name ?? ""), online: x.online === true }; });
    },
    accept(cb) { acceptors.push(cb); },
  };
}
