// Noise_NK_25519_ChaChaPoly_BLAKE2s and Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s (Noise revision 34).
// Handshake payloads are empty, so each handshake message is its ephemeral/static-derived tokens plus one
// 16-byte tag. Pure TypeScript: no Node built-ins and no Buffer.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";

export type NoisePattern = "NK" | "NNpsk0";

export interface NoiseOptions {
  initiator: boolean;
  pattern: NoisePattern;
  prologue: Uint8Array;
  /** NNpsk0: 32-byte pre-shared key, required on both sides. */
  psk?: Uint8Array;
  /** NK responder: 32-byte static private key. */
  staticPrivate?: Uint8Array;
  /** NK initiator: the responder's 32-byte static public key, obtained out of band. */
  pinnedPublic?: Uint8Array;
}

export interface Channel {
  seal(plain: Uint8Array): Uint8Array;
  open(cipher: Uint8Array): Uint8Array;
}

export interface Noise {
  /** Produces the next handshake message this side sends. */
  write(): Uint8Array;
  /** Consumes the next handshake message the peer sends. Throws on any malformed or unauthenticated input. */
  read(msg: Uint8Array): void;
  /** Completes the handshake and returns the transport channel. May be called exactly once. */
  split(): Channel;
}

export interface StaticKeys {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Test-only inputs for replaying published vectors. Production code never passes these. */
export interface TestInputs {
  /** Ephemeral private key for handshake message i (default: fresh random). */
  ephemerals?: Uint8Array[];
  /** Handshake payload for message i (default: empty). Both sides must agree on it. */
  payloads?: Uint8Array[];
  /** First transport nonce on both sides (default: 0). */
  startNonce?: bigint;
}

export interface NoiseHarness {
  noise: Noise;
  handshakeHash(): Uint8Array;
}

const KEY = 32;
const TAG = 16;
const MAX_MESSAGE = 65535;
const MAX_PLAINTEXT = MAX_MESSAGE - TAG;
// The spec reserves nonce 2^64-1; reaching it means the session is exhausted.
const NONCE_LIMIT = (1n << 64n) - 1n;

const EMPTY = new Uint8Array(0);
const te = new TextEncoder();

type Token = "e" | "es" | "ee" | "psk";
interface Pattern { preResponderStatic: boolean; msgs: Token[][] }
const PATTERNS: Record<NoisePattern, Pattern> = {
  NK: { preResponderStatic: true, msgs: [["e", "es"], ["e", "ee"]] },
  NNpsk0: { preResponderStatic: false, msgs: [["psk", "e"], ["e", "ee"]] },
};

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const nonceBytes = (n: bigint): Uint8Array => {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, n, true);
  return nonce;
};

// HKDF from Noise section 4.3, instantiated with HMAC-BLAKE2s.
function hkdf(ck: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tk = hmac(blake2s, ck, ikm);
  const o1 = hmac(blake2s, tk, Uint8Array.of(1));
  const o2 = hmac(blake2s, tk, cat(o1, Uint8Array.of(2)));
  if (outputs === 2) return [o1, o2];
  return [o1, o2, hmac(blake2s, tk, cat(o2, Uint8Array.of(3)))];
}

class Symmetric {
  private ck: Uint8Array;
  private h: Uint8Array;
  private k: Uint8Array | null = null;
  private n = 0n;

  constructor(protocolName: string) {
    const name = te.encode(protocolName);
    this.h = name.length <= KEY ? cat(name, new Uint8Array(KEY - name.length)) : blake2s(name);
    this.ck = this.h;
  }

  mixHash(d: Uint8Array): void {
    this.h = blake2s(cat(this.h, d));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck!;
    this.k = k!;
    this.n = 0n;
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, th, k] = hkdf(this.ck, ikm, 3);
    this.ck = ck!;
    this.mixHash(th!);
    this.k = k!;
    this.n = 0n;
  }

  encryptAndHash(plain: Uint8Array): Uint8Array {
    const ct = chacha20poly1305(this.requireKey(), nonceBytes(this.n), this.h).encrypt(plain);
    this.n++;
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = chacha20poly1305(this.requireKey(), nonceBytes(this.n), this.h).decrypt(ct);
    this.n++;
    this.mixHash(ct);
    return pt;
  }

  split(): [Uint8Array, Uint8Array] {
    const [c1, c2] = hkdf(this.ck, EMPTY, 2);
    return [c1!, c2!];
  }

  handshakeHash(): Uint8Array {
    return this.h;
  }

  private requireKey(): Uint8Array {
    if (this.k === null) throw new Error("noise: no key established");
    return this.k;
  }
}

// One direction of transport. The nonce is an implicit counter: it is never sent and only advances.
class CipherState {
  private n: bigint;

  constructor(private readonly k: Uint8Array, start: bigint) {
    this.n = start;
  }

  encrypt(plain: Uint8Array): Uint8Array {
    return chacha20poly1305(this.k, this.nextNonce(), EMPTY).encrypt(plain);
  }

  decrypt(cipher: Uint8Array): Uint8Array {
    return chacha20poly1305(this.k, this.nextNonce(), EMPTY).decrypt(cipher);
  }

  private nextNonce(): Uint8Array {
    if (this.n >= NONCE_LIMIT) throw new Error("noise: key exhausted, start a new handshake");
    const nonce = nonceBytes(this.n);
    this.n++;
    return nonce;
  }
}

// The counter is implicit, so a dropped, replayed or reordered message cannot be recovered from.
// Any rejected inbound message therefore closes the channel instead of allowing retries.
class Session implements Channel {
  private closed = false;

  constructor(private readonly tx: CipherState, private readonly rx: CipherState) {}

  seal(plain: Uint8Array): Uint8Array {
    this.assertOpen();
    if (plain.length > MAX_PLAINTEXT) throw new Error("noise: plaintext does not fit in one transport message");
    return this.tx.encrypt(plain);
  }

  open(cipher: Uint8Array): Uint8Array {
    this.assertOpen();
    try {
      if (cipher.length < TAG || cipher.length > MAX_MESSAGE) throw new Error("noise: transport message length out of range");
      return this.rx.decrypt(cipher);
    } catch (err) {
      this.closed = true;
      throw err;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("noise: channel closed after a rejected message");
  }
}

interface Keys { s?: Uint8Array; rs?: Uint8Array; psk?: Uint8Array }

function resolveKeys(o: NoiseOptions): Keys {
  const role = o.initiator ? "initiator" : "responder";
  const key32 = (k: Uint8Array | undefined, name: string): Uint8Array => {
    if (!(k instanceof Uint8Array) || k.length !== KEY) throw new Error(`noise: ${name} must be a 32-byte key`);
    return k;
  };
  const forbid = (k: unknown, name: string): void => {
    if (k !== undefined) throw new Error(`noise: ${name} is not used by ${o.pattern} ${role}`);
  };
  if (o.pattern === "NK") {
    forbid(o.psk, "psk");
    if (o.initiator) {
      forbid(o.staticPrivate, "staticPrivate");
      return { rs: key32(o.pinnedPublic, "pinnedPublic") };
    }
    forbid(o.pinnedPublic, "pinnedPublic");
    return { s: key32(o.staticPrivate, "staticPrivate") };
  }
  if (o.pattern === "NNpsk0") {
    forbid(o.staticPrivate, "staticPrivate");
    forbid(o.pinnedPublic, "pinnedPublic");
    return { psk: key32(o.psk, "psk") };
  }
  throw new Error("noise: unsupported pattern");
}

function build(o: NoiseOptions, inputs: TestInputs = {}): NoiseHarness {
  const keys = resolveKeys(o);
  if (!(o.prologue instanceof Uint8Array)) throw new Error("noise: prologue must be a Uint8Array");
  const startNonce = inputs.startNonce ?? 0n;
  if (startNonce < 0n || startNonce >= NONCE_LIMIT) throw new Error("noise: startNonce out of range");

  const { preResponderStatic, msgs } = PATTERNS[o.pattern];
  const pskMode = msgs.some((m) => m.includes("psk"));
  const initiator = o.initiator;

  const sym = new Symmetric(`Noise_${o.pattern}_25519_ChaChaPoly_BLAKE2s`);
  sym.mixHash(o.prologue);
  if (preResponderStatic) sym.mixHash(initiator ? keys.rs! : x25519.getPublicKey(keys.s!));

  let next = 0;
  let phase: "handshake" | "split" | "failed" = "handshake";
  let e: Uint8Array | null = null; // local ephemeral private key
  let re: Uint8Array | null = null; // remote ephemeral public key

  // One handshake message. `wire` is null when writing, the received bytes when reading.
  const step = (wire: Uint8Array | null): Uint8Array => {
    if (phase === "failed") throw new Error("noise: handshake failed");
    if (phase === "split" || next >= msgs.length) throw new Error("noise: handshake already complete");
    const i = next;
    const writing = wire === null;
    // Message i is sent by the initiator when i is even, by the responder when odd.
    const mine = (i % 2 === 0) === initiator;
    if (mine !== writing) {
      throw new Error(writing ? "noise: the peer writes the next handshake message" : "noise: this side writes the next handshake message");
    }
    const expected = inputs.payloads?.[i] ?? EMPTY;
    try {
      const out: Uint8Array[] = [];
      let off = 0;
      for (const t of msgs[i]!) {
        if (t === "psk") {
          sym.mixKeyAndHash(keys.psk!);
        } else if (t === "e") {
          let pub: Uint8Array;
          if (writing) {
            e = inputs.ephemerals?.[i] ?? x25519.utils.randomSecretKey();
            pub = x25519.getPublicKey(e);
            out.push(pub);
          } else {
            if (wire.length < off + KEY) throw new Error("noise: handshake message too short");
            pub = wire.slice(off, off + KEY);
            off += KEY;
            re = pub;
          }
          sym.mixHash(pub);
          if (pskMode) sym.mixKey(pub);
        } else if (t === "es") {
          // The initiator's ephemeral against the responder's static key, computed from either side.
          sym.mixKey(initiator ? x25519.getSharedSecret(e!, keys.rs!) : x25519.getSharedSecret(keys.s!, re!));
        } else {
          sym.mixKey(x25519.getSharedSecret(e!, re!));
        }
      }
      if (writing) {
        out.push(sym.encryptAndHash(expected));
        next++;
        return cat(...out);
      }
      if (wire.length !== off + TAG) throw new Error("noise: handshake message has the wrong length");
      const pt = sym.decryptAndHash(wire.subarray(off));
      if (pt.length !== expected.length || pt.some((b, k) => b !== expected[k])) throw new Error("noise: unexpected handshake payload");
      next++;
      return EMPTY;
    } catch (err) {
      phase = "failed";
      throw err;
    }
  };

  const split = (): Channel => {
    if (phase === "failed") throw new Error("noise: handshake failed");
    if (phase === "split") throw new Error("noise: split already called");
    if (next !== msgs.length) throw new Error("noise: handshake incomplete");
    const [c1, c2] = sym.split();
    phase = "split";
    e = null;
    re = null;
    const [tx, rx] = initiator ? [c1, c2] : [c2, c1];
    return new Session(new CipherState(tx, startNonce), new CipherState(rx, startNonce));
  };

  return {
    noise: { write: () => step(null), read: (msg) => void step(msg), split },
    handshakeHash: () => {
      if (phase !== "split") throw new Error("noise: handshake not complete");
      return sym.handshakeHash();
    },
  };
}

export function createNoise(options: NoiseOptions): Noise {
  return build(options).noise;
}

/** Conformance entry point: fixed ephemerals/payloads, plus the handshake hash for comparison with vectors. */
export function createNoiseForTesting(options: NoiseOptions, inputs: TestInputs): NoiseHarness {
  return build(options, inputs);
}

export function generateStatic(): StaticKeys {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}
