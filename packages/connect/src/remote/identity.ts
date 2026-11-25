import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { generateKeyPair, type KeyPair } from "./noise.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

/** Short, human-comparable fingerprint of a static key (shown on the trusted device, compared in the browser). */
export const fingerprint = (pub: Uint8Array): string => createHash("sha256").update(pub).digest("hex").slice(0, 16);

export interface DeviceIdentity { deviceId: string; keys: KeyPair; paired: Set<string> }

interface Stored { deviceId: string; priv: string; pub: string; paired: string[] }

/** Long-term device key pair and the set of paired client keys; the private key never leaves this file (mode 0600). */
export class IdentityStore {
  readonly identity: DeviceIdentity;
  constructor(private file: string) {
    if (fs.existsSync(file)) {
      const s = JSON.parse(fs.readFileSync(file, "utf8")) as Stored;
      this.identity = { deviceId: s.deviceId, keys: { priv: unhex(s.priv), pub: unhex(s.pub) }, paired: new Set(s.paired) };
    } else {
      this.identity = { deviceId: randomBytes(8).toString("hex"), keys: generateKeyPair(), paired: new Set() };
      this.save();
    }
  }
  private save() {
    const s: Stored = { deviceId: this.identity.deviceId, priv: hex(this.identity.keys.priv), pub: hex(this.identity.keys.pub), paired: [...this.identity.paired] };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(s), { mode: 0o600 });
  }
  isPaired(clientPub: Uint8Array): boolean { return this.identity.paired.has(hex(clientPub)); }
  addPaired(clientPub: Uint8Array) { this.identity.paired.add(hex(clientPub)); this.save(); }
  /** Device revocation; the rotation flow around it is [未决]. */
  revoke(clientPub: Uint8Array) { this.identity.paired.delete(hex(clientPub)); this.save(); }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_TTL_MS = 5 * 60_000;

/** Single-use pairing codes; compared in constant time and expired by wall clock. */
export class PairingCodes {
  private codes = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  issue(): { code: string; expiresAt: number } {
    const bytes = randomBytes(8);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join("");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }
  consume(candidate: string): boolean {
    let hit: string | null = null;
    for (const [code, exp] of this.codes) {
      if (exp <= this.now()) { this.codes.delete(code); continue; }
      const a = Buffer.from(code), b = Buffer.from(candidate);
      if (a.length === b.length && timingSafeEqual(a, b)) hit = code;
    }
    if (hit) this.codes.delete(hit);
    return hit !== null;
  }
}
