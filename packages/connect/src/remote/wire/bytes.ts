const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode bytes using RFC 4648 padded base64. Works in browsers and Bun. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + "=";
  }
  return out;
}

/** Decode strict RFC 4648 padded base64. */
export function fromBase64(encoded: string): Uint8Array {
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("invalid base64");
  const out = new Uint8Array((encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0));
  let oi = 0;
  for (let i = 0; i < encoded.length; i += 4) {
    const a = ALPHABET.indexOf(encoded[i]!); const b = ALPHABET.indexOf(encoded[i + 1]!);
    const c = encoded[i + 2] === "=" ? 0 : ALPHABET.indexOf(encoded[i + 2]!);
    const d = encoded[i + 3] === "=" ? 0 : ALPHABET.indexOf(encoded[i + 3]!);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (oi < out.length) out[oi++] = (n >>> 16) & 255;
    if (oi < out.length) out[oi++] = (n >>> 8) & 255;
    if (oi < out.length) out[oi++] = n & 255;
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function utf8(text: string): Uint8Array { return new TextEncoder().encode(text); }
export function text(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}
