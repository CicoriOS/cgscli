import { expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { bytesToNumberBE, concatBytes, hexToBytes } from "@noble/curves/utils.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { fromBase64, toBase64 } from "./bytes.ts";
import {
  createPasswordVerifier,
  deriveSecret,
  spake2Keys,
  spake2Share,
  spake2Shared,
  spake2Transcript,
  startPake,
} from "./pake.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// RFC 9106 §5.3, Argon2id version 0x13, 32 KiB, 3 passes, 4 lanes, 32-byte tag.
test("Argon2id matches the RFC 9106 §5.3 test vector", async () => {
  const tag = await argon2idAsync(new Uint8Array(32).fill(0x01), new Uint8Array(16).fill(0x02), {
    t: 3,
    m: 32,
    p: 4,
    version: 0x13,
    dkLen: 32,
    key: new Uint8Array(8).fill(0x03),
    personalization: new Uint8Array(12).fill(0x04),
  });
  expect(tag).toEqual(hexToBytes("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"));
});

type Spake2Vector = {
  idA: string;
  idB: string;
  w: string;
  x: string;
  y: string;
  pA: string;
  pB: string;
  k: string;
  ke: string;
  ka: string;
};

// RFC 9382 Appendix B, SPAKE2 over P-256 with SHA-256 (symmetric variant, M and N from Table 1).
// pA = x*G + w*M, pB = y*G + w*N, K = x*(pB - w*N) = y*(pA - w*M), Ke || Ka = SHA-256(TT).
const SPAKE2_P256_VECTORS: readonly Spake2Vector[] = [
  {
    idA: "",
    idB: "client",
    w: "0548d8729f730589e579b0475a582c1608138ddf7054b73b5381c7e883e2efae",
    x: "403abbe3b1b4b9ba17e3032849759d723939a27a27b9d921c500edde18ed654b",
    y: "903023b6598908936ea7c929bd761af6039577a9c3f9581064187c3049d87065",
    pA: "04a897b769e681c62ac1c2357319a3d363f610839c4477720d24cbe32f5fd85f44fb92ba966578c1b712be6962498834078262caa5b441ecfa9d4a9485720e918a",
    pB: "04e0f816fd1c35e22065d5556215c097e799390d16661c386e0ecc84593974a61b881a8c82327687d0501862970c64565560cb5671f696048050ca66ca5f8cc7fc",
    k: "048f83ec9f6e4f87cc6f9dc740bdc2769725f923364f01c84148c049a39a735ebda82eac03e00112fd6a5710682767cff5361f7e819e53d8d3c3a2922e0d837aa6",
    ke: "642f05c473c2cd79909f9a841e2f30a7",
    ka: "0bf89b18180af97353ba198789c2b963",
  },
  {
    idA: "server",
    idB: "",
    w: "626e0cdc7b14c9db3e52a0b1b3a768c98e37852d5db30febe0497b14eae8c254",
    x: "07adb3db6bc623d3399726bfdbfd3d15a58ea776ab8a308b00392621291f9633",
    y: "b6a4fc8dbb629d4ba51d6f91ed1532cf87adec98f25dd153a75accafafedec16",
    pA: "04f88fb71c99bfffaea370966b7eb99cd4be0ff1a7d335caac4211c4afd855e2e15a873b298503ad8ba1d9cbb9a392d2ba309b48bfd7879aefd0f2cea6009763b0",
    pB: "040c269d6be017dccb15182ac6bfcd9e2a14de019dd587eaf4bdfd353f031101e7cca177f8eb362a6e83e7d5e729c0732e1b528879c086f39ba0f31a9661bd34db",
    k: "0445ee233b8ecb51ebd6e7da3f307e88a1616bae2166121221fdc0dadb986afaf3ec8a988dc9c626fa3b99f58a7ca7c9b844bb3e8dd9554aafc5b53813504c1cbe",
    ke: "005184ff460da2ce59062c87733c299c",
    ka: "3521297d736598fc0a1127600efa1afb",
  },
  {
    idA: "",
    idB: "",
    w: "7bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70cca",
    x: "8cef65df64bb2d0f83540c53632de911b5b24b3eab6cc74a97609fd659e95473",
    y: "d7a66f64074a84652d8d623a92e20c9675c61cb5b4f6a0063e4648a2fdc02d53",
    pA: "04a65b367a3f613cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f46ca1ef6a676598889fc28de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66",
    pB: "04589f13218822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494662eea8ba6b64692dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d",
    k: "041a3c03d51b452537ca2a1fea6110353c6d5ed483c4f0f86f4492ca3f378d40a994b4477f93c64d928edbbcd3e85a7c709b7ea73ee97986ce3d1438e135543772",
    ke: "fc6374762ba5cf11f4b2caa08b2cd1b9",
    ka: "907ae0e26e8d6234318d91583cd74c86",
  },
];

for (const v of SPAKE2_P256_VECTORS) {
  test(`RFC 9382 Appendix B SPAKE2 P-256 vector (A='${v.idA}', B='${v.idB}')`, () => {
    const w = bytesToNumberBE(hexToBytes(v.w));
    const x = bytesToNumberBE(hexToBytes(v.x));
    const y = bytesToNumberBE(hexToBytes(v.y));
    const pA = hexToBytes(v.pA);
    const pB = hexToBytes(v.pB);
    const k = hexToBytes(v.k);

    expect(spake2Share("A", w, x).toBytes(false)).toEqual(pA);
    expect(spake2Share("B", w, y).toBytes(false)).toEqual(pB);
    expect(spake2Shared("A", w, x, p256.Point.fromBytes(pB)).toBytes(false)).toEqual(k);
    expect(spake2Shared("B", w, y, p256.Point.fromBytes(pA)).toBytes(false)).toEqual(k);

    const tt = spake2Transcript(enc(v.idA), enc(v.idB), pA, pB, k, w);
    const { ke, ka } = spake2Keys(tt);
    expect(ke).toEqual(hexToBytes(v.ke));
    expect(ka).toEqual(hexToBytes(v.ka));
  });
}

const PASSWORD = "correct horse battery staple";
const VERIFIER = await createPasswordVerifier(PASSWORD);
const CONTEXT = concatBytes(fromBase64(VERIFIER.salt), enc("sid-1"));
const fresh = (role: "A" | "B" = "A", secret = VERIFIER.secret, context = CONTEXT) =>
  startPake(role, secret, context);

test("createPasswordVerifier emits canonical v1 fields", () => {
  expect(VERIFIER.v).toBe(1);
  expect(fromBase64(VERIFIER.salt).length).toBe(16);
  expect(toBase64(fromBase64(VERIFIER.salt))).toBe(VERIFIER.salt);
  expect(fromBase64(VERIFIER.secret).length).toBe(32);
  expect(toBase64(fromBase64(VERIFIER.secret))).toBe(VERIFIER.secret);
});

test("deriveSecret reproduces the stored verifier secret", async () => {
  expect(await deriveSecret(PASSWORD, VERIFIER.salt)).toBe(VERIFIER.secret);
});

test("deriveSecret rejects empty passwords and salts that are not 16 bytes", async () => {
  await expect(deriveSecret("", VERIFIER.salt)).rejects.toThrow();
  await expect(deriveSecret(PASSWORD, toBase64(new Uint8Array(8)))).rejects.toThrow();
});

test("A and B derive the same 32-byte PSK", () => {
  const a = fresh("A");
  const b = fresh("B");
  const psk = a.finish(b.share);
  expect(psk.length).toBe(32);
  expect(b.finish(a.share)).toEqual(psk);
});

test("the PSK is bound to the context (salt and session id)", () => {
  const a = fresh("A", VERIFIER.secret, enc("sid-1"));
  const b = fresh("B", VERIFIER.secret, enc("sid-2"));
  expect(a.finish(b.share)).not.toEqual(b.finish(a.share));
});

test("mismatched passwords do not agree on the PSK", async () => {
  const other = await createPasswordVerifier("a different password");
  const a = fresh("A");
  const b = fresh("B", other.secret);
  expect(a.finish(b.share)).not.toEqual(b.finish(a.share));
});

test("finish rejects wrong-length, wrong-encoding, off-curve and reflected shares", () => {
  const peer = fresh("B");
  expect(() => fresh("A").finish(peer.share.slice(1))).toThrow("pake: peer share");
  expect(() => fresh("A").finish(p256.Point.fromBytes(peer.share).toBytes(true))).toThrow("pake: peer share");
  expect(() => fresh("A").finish(concatBytes(new Uint8Array([0x04]), new Uint8Array(64).fill(0x01)))).toThrow();
  const own = fresh("A");
  expect(() => own.finish(own.share)).toThrow("reflected");
});

test("finish is single-use", () => {
  const a = fresh("A");
  const b = fresh("B");
  a.finish(b.share);
  expect(() => a.finish(b.share)).toThrow("already finished");
});

test("startPake rejects degenerate, wrong-length, non-base64 secrets and invalid roles", () => {
  expect(() => startPake("A", toBase64(new Uint8Array(32)), CONTEXT)).toThrow("degenerate");
  expect(() => startPake("A", toBase64(new Uint8Array(31)), CONTEXT)).toThrow();
  expect(() => startPake("A", "not base64!", CONTEXT)).toThrow();
  expect(() => startPake("C" as never, VERIFIER.secret, CONTEXT)).toThrow("invalid role");
});
