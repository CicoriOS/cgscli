// Noise_NK_25519_ChaChaPoly_BLAKE2s with prologue "cgs-tunnel/v1", matching new-api tunnelkit/noise.go
// (flynn/noise). The responder side exists so tests can run a local gateway; the device only needs the initiator.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";

export const PROLOGUE = "cgs-tunnel/v1";
export const MAX_MESSAGE = 65535;
export const TAG_SIZE = 16;
export const MAX_PLAINTEXT = MAX_MESSAGE - TAG_SIZE;

const PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_BLAKE2s";
const te = new TextEncoder();
const EMPTY = new Uint8Array(0);

const cat = (...a: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) { out.set(x, o); o += x.length; }
  return out;
};
const hash = (d: Uint8Array) => blake2s(d);
const mac = (k: Uint8Array, d: Uint8Array) => hmac(blake2s, k, d);

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = mac(ck, ikm);
  const o1 = mac(temp, Uint8Array.of(1));
  const o2 = mac(temp, cat(o1, Uint8Array.of(2)));
  return [o1, o2];
}

/** One direction of the transport: 4 zero bytes + 64-bit little-endian counter as nonce. */
export class CipherState {
  private n = 0n;
  constructor(private k: Uint8Array) {}
  private nonce(): Uint8Array {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, this.n, true);
    return nonce;
  }
  encrypt(plain: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    const out = chacha20poly1305(this.k, this.nonce(), ad).encrypt(plain);
    this.n++;
    return out;
  }
  decrypt(ct: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    const out = chacha20poly1305(this.k, this.nonce(), ad).decrypt(ct);
    this.n++;
    return out;
  }
}

export class Symmetric {
  ck: Uint8Array;
  h: Uint8Array;
  private cs: CipherState | null = null;
  constructor(protocolName: string = PROTOCOL_NAME, prologue: string = PROLOGUE) {
    const name = te.encode(protocolName);
    this.h = name.length <= 32 ? cat(name, new Uint8Array(32 - name.length)) : hash(name);
    this.ck = this.h;
    this.mixHash(te.encode(prologue));
  }
  hasKey(): boolean { return this.cs !== null; }
  mixHash(d: Uint8Array) { this.h = hash(cat(this.h, d)); }
  mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cs = new CipherState(k);
  }
  encryptAndHash(p: Uint8Array): Uint8Array {
    const ct = this.cs ? this.cs.encrypt(p, this.h) : p;
    this.mixHash(ct);
    return ct;
  }
  decryptAndHash(ct: Uint8Array): Uint8Array {
    const p = this.cs ? this.cs.decrypt(ct, this.h) : ct;
    this.mixHash(ct);
    return p;
  }
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

export interface Transport { send: CipherState; recv: CipherState }
export interface InitiatorHandshake { msg1: Uint8Array; finish(msg2: Uint8Array): Transport }

/** NK initiator: `-> e, es` / `<- e, ee`. gatewayPub is the 32-byte static key of the gateway. */
export function noiseInitiator(gatewayPub: Uint8Array): InitiatorHandshake {
  if (gatewayPub.length !== 32) throw new Error("gateway public key must be 32 bytes");
  const s = new Symmetric();
  s.mixHash(gatewayPub); // pre-message: <- s
  const e = x25519.utils.randomSecretKey();
  const epub = x25519.getPublicKey(e);
  s.mixHash(epub);
  s.mixKey(x25519.getSharedSecret(e, gatewayPub));
  const msg1 = cat(epub, s.encryptAndHash(EMPTY));
  return {
    msg1,
    finish(msg2) {
      if (msg2.length < 32) throw new Error("tunnel handshake: short message");
      const re = msg2.subarray(0, 32);
      s.mixHash(re);
      s.mixKey(x25519.getSharedSecret(e, re));
      s.decryptAndHash(msg2.subarray(32));
      const [send, recv] = s.split();
      return { send, recv };
    },
  };
}

/** NK responder for one candidate key; throws if msg1 was not made for `priv`'s public key. */
export function noiseResponder(priv: Uint8Array, msg1: Uint8Array): { msg2: Uint8Array; transport: Transport } {
  const s = new Symmetric();
  s.mixHash(x25519.getPublicKey(priv));
  if (msg1.length < 32) throw new Error("tunnel handshake: short message");
  const re = msg1.subarray(0, 32);
  s.mixHash(re);
  s.mixKey(x25519.getSharedSecret(priv, re));
  s.decryptAndHash(msg1.subarray(32));
  const e = x25519.utils.randomSecretKey();
  const epub = x25519.getPublicKey(e);
  s.mixHash(epub);
  s.mixKey(x25519.getSharedSecret(e, re));
  const msg2 = cat(epub, s.encryptAndHash(EMPTY));
  const [recv, send] = s.split();
  return { msg2, transport: { send, recv } };
}
