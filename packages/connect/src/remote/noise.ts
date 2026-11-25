// Generic Noise handshake (XX and IK) for the remote link. Which pattern the product uses is undecided
// ([未决] remote.md "Noise 模式 XX 与 IK"), so the pattern is an explicit parameter with no default.
import { x25519 } from "@noble/curves/ed25519.js";
import { Symmetric, type Transport } from "../router/noise.ts";

export type PatternName = "XX" | "IK";
export const REMOTE_PROLOGUE = "cgs-remote/v1";

interface Pattern { preResponderStatic: boolean; msgs: string[][] }
const PATTERNS: Record<PatternName, Pattern> = {
  XX: { preResponderStatic: false, msgs: [["e"], ["e", "ee", "s", "es"], ["s", "se"]] },
  IK: { preResponderStatic: true, msgs: [["e", "es", "s", "ss"], ["e", "ee", "se"]] },
};

export interface KeyPair { priv: Uint8Array; pub: Uint8Array }
export const generateKeyPair = (): KeyPair => {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
};

export interface HandshakeOptions { pattern: PatternName; initiator: boolean; s: KeyPair; rs?: Uint8Array }

export class Handshake {
  private sym: Symmetric;
  private p: Pattern;
  private e: KeyPair | null = null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null;
  private i = 0;
  constructor(private o: HandshakeOptions) {
    this.p = PATTERNS[o.pattern];
    this.sym = new Symmetric(`Noise_${o.pattern}_25519_ChaChaPoly_BLAKE2s`, REMOTE_PROLOGUE);
    this.rs = o.rs ?? null;
    if (this.p.preResponderStatic) {
      const responderStatic = o.initiator ? o.rs : o.s.pub;
      if (!responderStatic) throw new Error("IK initiator needs the responder's static key");
      this.sym.mixHash(responderStatic);
    }
  }

  get done(): boolean { return this.i >= this.p.msgs.length; }
  get remoteStatic(): Uint8Array | null { return this.rs; }
  private get myTurn(): boolean { return this.i % 2 === (this.o.initiator ? 0 : 1); }

  private dh(a: string): Uint8Array {
    const init = this.o.initiator;
    const [l, r] = [a[0]!, a[1]!];
    const local = (k: string) => (k === "e" ? this.e!.priv : this.o.s.priv);
    const remote = (k: string) => (k === "e" ? this.re! : this.rs!);
    // token "xy": x is the initiator's key, y the responder's
    return x25519.getSharedSecret(init ? local(l) : local(r), init ? remote(r) : remote(l));
  }

  write(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.done || !this.myTurn) throw new Error("not our turn to write");
    const out: Uint8Array[] = [];
    for (const t of this.p.msgs[this.i]!) {
      if (t === "e") { this.e = generateKeyPair(); out.push(this.e.pub); this.sym.mixHash(this.e.pub); }
      else if (t === "s") out.push(this.sym.encryptAndHash(this.o.s.pub));
      else this.sym.mixKey(this.dh(t));
    }
    out.push(this.sym.encryptAndHash(payload));
    this.i++;
    return Buffer.concat(out);
  }

  read(msg: Uint8Array): Uint8Array {
    if (this.done || this.myTurn) throw new Error("not our turn to read");
    let off = 0;
    for (const t of this.p.msgs[this.i]!) {
      if (t === "e") { this.re = msg.subarray(off, off + 32); off += 32; if (this.re.length !== 32) throw new Error("short handshake message"); this.sym.mixHash(this.re); }
      else if (t === "s") { const n = this.sym.hasKey() ? 48 : 32; this.rs = this.sym.decryptAndHash(msg.subarray(off, off + n)); off += n; }
      else this.sym.mixKey(this.dh(t));
    }
    const payload = this.sym.decryptAndHash(msg.subarray(off));
    this.i++;
    return payload;
  }

  split(): Transport {
    if (!this.done) throw new Error("handshake incomplete");
    const [c1, c2] = this.sym.split();
    return this.o.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}
