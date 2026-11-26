import { p256 } from "@noble/curves/nist.js";
import type { WeierstrassPoint } from "@noble/curves/abstract/weierstrass.js";
import { bytesToNumberBE, concatBytes, equalBytes, numberToBytesBE, randomBytes } from "@noble/curves/utils.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64, toBase64 } from "./bytes.ts";

/**
 * Password-authenticated key exchange for the connect wire protocol.
 *
 * - Verifier: Argon2id(password, salt) with a fixed profile (RFC 9106 second recommended
 *   profile: t=3, m=64 MiB, p=4). The 32-byte output is the stored `secret`.
 * - Exchange: SPAKE2 (RFC 9382) over P-256 with SHA-256, symmetric variant (M and N are the
 *   RFC 9382 Table 1 points for P-256). The stored secret is used as the scalar `w`.
 * - Output: 32-byte PSK = HKDF-SHA256(ikm = Ke, info = label || context), where Ke is the
 *   first half of SHA-256(TT) per RFC 9382 §4. `context` must carry the salt and session id.
 */

export type PasswordVerifier = { v: 1; salt: string; secret: string };
export type PakeRole = "A" | "B";

type P256Point = WeierstrassPoint<bigint>;

const N = p256.Point.Fn.ORDER;
const G = p256.Point.BASE;
// RFC 9382 Table 1, P-256 (compressed SEC1 encodings).
const POINT_M = p256.Point.fromHex("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f");
const POINT_N = p256.Point.fromHex("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49");

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ID_A = enc("cgscli connect SPAKE2 A");
const ID_B = enc("cgscli connect SPAKE2 B");
const PSK_INFO = enc("cgscli connect SPAKE2 PSK v1");
const SALT_BYTES = 16;
const SECRET_BYTES = 32;
const SHARE_BYTES = 65;
const KE_BYTES = 16;
const PSK_BYTES = 32;
const ARGON2ID_PROFILE = { t: 3, m: 64 * 1024, p: 4, version: 0x13, dkLen: SECRET_BYTES } as const;

function decodeCanonical(encoded: string, length: number): Uint8Array {
  const bytes = fromBase64(encoded);
  if (bytes.length !== length || toBase64(bytes) !== encoded) {
    throw new Error("pake: base64 must be canonical and of the expected length");
  }
  return bytes;
}

function secretScalar(secret: string): bigint {
  const w = bytesToNumberBE(decodeCanonical(secret, SECRET_BYTES)) % N;
  if (w === 0n) throw new Error("pake: degenerate secret");
  return w;
}

function decodeShare(bytes: Uint8Array): P256Point {
  if (bytes.length !== SHARE_BYTES || bytes[0] !== 0x04) {
    throw new Error("pake: peer share must be an uncompressed P-256 point");
  }
  const point = p256.Point.fromBytes(bytes);
  point.assertValidity();
  return point;
}

const lengthPrefixed = (bytes: Uint8Array): Uint8Array => {
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(bytes.length), true);
  return concatBytes(len, bytes);
};

/** @internal Own SPAKE2 share: scalar*G + w*M for A, scalar*G + w*N for B. */
export function spake2Share(role: PakeRole, w: bigint, scalar: bigint): P256Point {
  const blind = role === "A" ? POINT_M : POINT_N;
  const share = G.multiply(scalar).add(blind.multiply(w));
  if (share.is0()) throw new Error("pake: degenerate share");
  return share;
}

/** @internal Shared point: scalar * (peer - w*(peer's blind)). */
export function spake2Shared(role: PakeRole, w: bigint, scalar: bigint, peer: P256Point): P256Point {
  const peerBlind = role === "A" ? POINT_N : POINT_M;
  const unblinded = peer.subtract(peerBlind.multiply(w));
  if (unblinded.is0()) throw new Error("pake: peer share is degenerate");
  const z = unblinded.multiply(scalar);
  if (z.is0()) throw new Error("pake: shared point is degenerate");
  return z;
}

/** @internal TT = len(A)||A||len(B)||B||len(X)||X||len(Y)||Y||len(Z)||Z||len(w)||w (8-byte LE lengths). */
export function spake2Transcript(
  idA: Uint8Array,
  idB: Uint8Array,
  pA: Uint8Array,
  pB: Uint8Array,
  z: Uint8Array,
  w: bigint,
): Uint8Array {
  return concatBytes(
    lengthPrefixed(idA),
    lengthPrefixed(idB),
    lengthPrefixed(pA),
    lengthPrefixed(pB),
    lengthPrefixed(z),
    lengthPrefixed(numberToBytesBE(w, SECRET_BYTES)),
  );
}

/** @internal Ke || Ka = SHA-256(TT), each half 128 bits (RFC 9382 §4). */
export function spake2Keys(tt: Uint8Array): { ke: Uint8Array; ka: Uint8Array } {
  const h = sha256(tt);
  return { ke: h.slice(0, KE_BYTES), ka: h.slice(KE_BYTES) };
}

export async function deriveSecret(password: string, salt: string): Promise<string> {
  if (password.length === 0) throw new Error("pake: empty password");
  const saltBytes = decodeCanonical(salt, SALT_BYTES);
  const secret = await argon2idAsync(enc(password), saltBytes, ARGON2ID_PROFILE);
  return toBase64(secret);
}

export async function createPasswordVerifier(password: string): Promise<PasswordVerifier> {
  const salt = toBase64(randomBytes(SALT_BYTES));
  return { v: 1, salt, secret: await deriveSecret(password, salt) };
}

/**
 * Starts one SPAKE2 side. Send `share` to the peer, then call `finish` once with the peer's
 * share to obtain the 32-byte PSK. `context` (salt, session id, ...) is bound into the PSK.
 */
export function startPake(
  role: PakeRole,
  secret: string,
  context: Uint8Array,
): { share: Uint8Array; finish(peer: Uint8Array): Uint8Array } {
  if (role !== "A" && role !== "B") throw new Error("pake: invalid role");
  const w = secretScalar(secret);
  const scalar = bytesToNumberBE(p256.utils.randomSecretKey());
  const share = spake2Share(role, w, scalar).toBytes(false);
  let finished = false;
  return {
    share,
    finish(peer: Uint8Array): Uint8Array {
      if (finished) throw new Error("pake: handshake already finished");
      finished = true;
      const peerPoint = decodeShare(peer);
      const peerBytes = peerPoint.toBytes(false);
      if (equalBytes(peerBytes, share)) throw new Error("pake: peer reflected own share");
      const z = spake2Shared(role, w, scalar, peerPoint);
      const [pA, pB] = role === "A" ? [share, peerBytes] : [peerBytes, share];
      const tt = spake2Transcript(ID_A, ID_B, pA, pB, z.toBytes(false), w);
      const { ke } = spake2Keys(tt);
      return hkdf(sha256, ke, undefined, concatBytes(PSK_INFO, context), PSK_BYTES);
    },
  };
}
