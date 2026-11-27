// Connect wire v1 handshakes and sessions. Public contract: README.md in this directory.
//
// Two ways in, both over relay `data` payloads (the relay sees only these bytes):
//
//   first connection (no saved pin; the browser shows the device key before it asks for the password)
//     B -> D  PW_START
//     D -> B  PW_CHALLENGE  salt(16) nonce(16) shareB(65) pub(32)   device SPAKE2 share and the device's static public key
//                                                               (a shorter challenge is a device from before the key was
//                                                               announced: the browser ends with code "device_outdated")
//     B -> D  PW_FINISH     shareA(65) noise-msg1               NNpsk0 with psk = SPAKE2 output
//     D -> B  PW_REPLY      noise-msg2                          (or ERROR "bad_password")
//     D -> B  DATA  {t:"device", pub}                           the device key the browser pins; must equal the one in PW_CHALLENGE
//
// The announced `pub` is not authenticated: anyone on the path can put any key there. It lets the user compare the
// fingerprint with the device terminal before typing the password. What stops an impostor is still the password
// (PAKE); the browser rejects a session whose `device` key differs from the one it showed.
//     B -> D  DATA  {t:"register", name, jwk}                   the browser's new non-extractable ECDSA key
//     D -> B  DATA  {t:"registered", id}
//
//   later connections (the browser has the pin and its key; no password)
//     B -> D  RESUME        noise-msg1                          NK to the pinned device key
//     D -> B  RESUME_REPLY  noise-msg2
//     D -> B  DATA  {t:"challenge", nonce}
//     B -> D  DATA  {t:"proof", jwk, sig}                       ECDSA over PROOF_TAG || nonce
//     D -> B  DATA  {t:"ok", id}                                or {t:"denied", code}
//
// DATA payload: 0x20 || channel.seal(kind || body); kind 0x01 is a handshake control (JSON), 0x02 an application
// record (messages.ts). A failed handshake never reveals which check failed beyond the codes below.
import { equalBytes, concatBytes, fromBase64, text, toBase64, utf8 } from "./bytes.ts";
import type { AuthorizedBrowser, DeviceCredentials } from "./credentials.ts";
import { encodeMessage, FrameDecoder, WireError, type EncodeOptions, type WireMessage } from "./messages.ts";
import { createNoise, type Channel } from "./noise.ts";
import { deriveSecret, startPake } from "./pake.ts";

export type Via = "password" | "key";

export type WireEvent =
  | { type: "authenticated"; via: Via; browser: { id: string; name: string } }
  | { type: "registered"; browser: AuthorizedBrowser }
  | { type: "challenged"; pin: string } // browser: the device answered PW_START; `pin` is its key from PW_CHALLENGE. Call answer().
  | { type: "pinned"; pin: string }
  | { type: "pin_mismatch"; expected: string; received: string }
  | { type: "auth_failed"; via: Via; code: string }
  | { type: "message"; message: WireMessage };

export type Step = { outgoing: Uint8Array[]; events: WireEvent[] };

/** What a browser persists per device and origin. `privateKey` is a non-extractable CryptoKey: store it with structured clone. */
export type SavedBrowser = { pin: string; privateKey: CryptoKey; publicKeyJwk: JsonWebKey; name: string };
export interface BrowserStore {
  load(): Promise<SavedBrowser | null>;
  save(value: SavedBrowser): Promise<void>;
}

const PW_START = 0x01;
const PW_CHALLENGE = 0x02;
const PW_FINISH = 0x03;
const PW_REPLY = 0x04;
const RESUME = 0x10;
const RESUME_REPLY = 0x11;
const DATA = 0x20;
const PIN_CLAIM = 0x7e;
const ERROR = 0x7f;

const KIND_CONTROL = 0x01;
const KIND_RECORD = 0x02;

const SALT_BYTES = 16;
const NONCE_BYTES = 16;
const CHALLENGE_BYTES = 32;
const SHARE_BYTES = 65;
const STATIC_BYTES = 32;
const MAX_NAME_CHARS = 64;

const PW_PROLOGUE = utf8("cgscli connect pw v1");
const RESUME_PROLOGUE = utf8("cgscli connect resume v1");
const PROOF_TAG = utf8("cgscli connect proof v1");
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

const tagged = (tag: number, ...parts: Uint8Array[]): Uint8Array => concatBytes(Uint8Array.of(tag), ...parts);
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type Control = Record<string, unknown> & { t: string };

function sealControl(channel: Channel, body: Control): Uint8Array {
  return tagged(DATA, channel.seal(tagged(KIND_CONTROL, utf8(JSON.stringify(body)))));
}

/** Opens a DATA payload. Control bodies come back parsed; records come back raw. */
function openData(channel: Channel, payload: Uint8Array): { control: Control } | { record: Uint8Array } {
  if (payload[0] !== DATA) throw new WireError("expected a data payload");
  const plain = channel.open(payload.subarray(1));
  if (plain.length < 1) throw new WireError("empty record");
  if (plain[0] === KIND_RECORD) return { record: plain.subarray(1) };
  if (plain[0] !== KIND_CONTROL) throw new WireError("unknown record kind");
  let body: unknown;
  try {
    body = JSON.parse(text(plain.subarray(1)));
  } catch {
    throw new WireError("control body is not JSON");
  }
  if (!body || typeof body !== "object" || typeof (body as Control).t !== "string") throw new WireError("control body has no type");
  return { control: body as Control };
}

const str = (value: unknown, what: string, max = 4096): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new WireError(`${what} must be a non-empty string`);
  return value;
};

/** The public part of a P-256 JWK, in one canonical shape; anything else is rejected. */
function publicJwk(value: unknown): JsonWebKey {
  const k = value as JsonWebKey | null;
  if (!k || typeof k !== "object" || k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string") {
    throw new WireError("key must be a P-256 public JWK");
  }
  return { kty: "EC", crv: "P-256", x: k.x, y: k.y };
}

const sameKey = (a: JsonWebKey, b: JsonWebKey): boolean => a.x === b.x && a.y === b.y;

function checkLength(bytes: Uint8Array, min: number, what: string): void {
  if (bytes.length < min) throw new WireError(`${what} is too short`);
}

// ---- device -----------------------------------------------------------------------------------------------------------

type DeviceState =
  | { s: "idle" }
  | { s: "pw_challenge"; pake: ReturnType<typeof startPake>; salt: Uint8Array; nonce: Uint8Array }
  | { s: "pw_register"; channel: Channel }
  | { s: "resume_proof"; channel: Channel; nonce: Uint8Array }
  | { s: "authed"; channel: Channel; decoder: FrameDecoder }
  | { s: "dead" };

export interface DeviceSessionOptions {
  credentials: DeviceCredentials;
  /** Asked before a password handshake starts. False refuses it with code "locked", which callers do not count as a failure. */
  passwordAllowed?: () => boolean;
  now?: () => number;
}

/**
 * Device end of one relay session (one per `sid`). I/O-free: feed it each inbound payload and deliver `outgoing` in
 * order. Process `events` before forwarding `outgoing`: a `registered` event must be persisted before the browser is
 * told it is registered. Calls must be serialized. A protocol violation throws; a wrong password or key is a normal
 * `auth_failed` event (code `bad_password`, `handshake`, `unknown_browser`, `bad_signature`, `no_password`, `locked`).
 */
export class DeviceSession {
  private state: DeviceState = { s: "idle" };
  private readonly credentials: DeviceCredentials;

  constructor(private readonly options: DeviceSessionOptions) {
    this.credentials = options.credentials;
  }

  async receive(payload: Uint8Array): Promise<Step> {
    if (payload.length === 0) throw new WireError("empty payload");
    const st = this.state;
    switch (st.s) {
      case "idle":
        return this.first(payload);
      case "pw_challenge":
        return this.passwordFinish(st, payload);
      case "pw_register":
        return this.register(st, payload);
      case "resume_proof":
        return this.proof(st, payload);
      case "authed":
        return this.application(st, payload);
      case "dead":
        throw new WireError("session is closed");
    }
  }

  /** Seals one application message for the authenticated browser. */
  async send(message: WireMessage, options?: EncodeOptions): Promise<Uint8Array[]> {
    const st = this.state;
    if (st.s !== "authed") throw new WireError("session is not authenticated");
    const records = await encodeMessage(message, options);
    return records.map((r) => tagged(DATA, st.channel.seal(tagged(KIND_RECORD, r))));
  }

  private fail(via: Via, code: string, outgoing: Uint8Array[]): Step {
    this.state = { s: "dead" };
    return { outgoing, events: [{ type: "auth_failed", via, code }] };
  }

  private first(payload: Uint8Array): Step {
    const c = this.credentials;
    if (payload[0] === PW_START) {
      const verifier = c.verifier;
      if (!verifier) return this.fail("password", "no_password", [tagged(ERROR, utf8("no_password"))]);
      if (this.options.passwordAllowed && !this.options.passwordAllowed()) return this.fail("password", "locked", [tagged(ERROR, utf8("locked"))]);
      const salt = fromBase64(verifier.salt);
      const nonce = random(NONCE_BYTES);
      const pake = startPake("B", verifier.secret, concatBytes(salt, nonce));
      this.state = { s: "pw_challenge", pake, salt, nonce };
      return { outgoing: [tagged(PW_CHALLENGE, salt, nonce, pake.share, fromBase64(c.staticKey.publicKey))], events: [] };
    }
    if (payload[0] === RESUME) {
      const noise = createNoise({ initiator: false, pattern: "NK", prologue: RESUME_PROLOGUE, staticPrivate: fromBase64(c.staticKey.privateKey) });
      try {
        noise.read(payload.subarray(1));
      } catch {
        // The initiator pinned some other key, or the bytes are damaged. Offer our key as an unauthenticated claim.
        return this.fail("key", "handshake", [tagged(PIN_CLAIM, fromBase64(c.staticKey.publicKey))]);
      }
      const reply = tagged(RESUME_REPLY, noise.write());
      const channel = noise.split();
      const nonce = random(CHALLENGE_BYTES);
      this.state = { s: "resume_proof", channel, nonce };
      return { outgoing: [reply, sealControl(channel, { t: "challenge", nonce: toBase64(nonce) })], events: [] };
    }
    throw new WireError("unexpected first payload");
  }

  private passwordFinish(st: Extract<DeviceState, { s: "pw_challenge" }>, payload: Uint8Array): Step {
    if (payload[0] !== PW_FINISH) throw new WireError("expected PW_FINISH");
    const body = payload.subarray(1);
    checkLength(body, SHARE_BYTES + 1, "PW_FINISH");
    let psk: Uint8Array;
    try {
      psk = st.pake.finish(body.subarray(0, SHARE_BYTES));
    } catch {
      throw new WireError("invalid PAKE share");
    }
    const noise = createNoise({ initiator: false, pattern: "NNpsk0", prologue: concatBytes(PW_PROLOGUE, st.salt, st.nonce), psk });
    try {
      noise.read(body.subarray(SHARE_BYTES));
    } catch {
      return this.fail("password", "bad_password", [tagged(ERROR, utf8("bad_password"))]);
    }
    const reply = tagged(PW_REPLY, noise.write());
    const channel = noise.split();
    this.state = { s: "pw_register", channel };
    return { outgoing: [reply, sealControl(channel, { t: "device", pub: this.credentials.staticKey.publicKey })], events: [] };
  }

  private register(st: Extract<DeviceState, { s: "pw_register" }>, payload: Uint8Array): Step {
    const opened = openData(st.channel, payload);
    if (!("control" in opened) || opened.control.t !== "register") throw new WireError("expected register");
    const name = str(opened.control.name, "name", MAX_NAME_CHARS);
    const browser: AuthorizedBrowser = { id: toHex(random(16)), name, publicKeyJwk: publicJwk(opened.control.jwk), addedAt: (this.options.now ?? Date.now)() };
    this.state = { s: "authed", channel: st.channel, decoder: new FrameDecoder() };
    return {
      outgoing: [sealControl(st.channel, { t: "registered", id: browser.id })],
      events: [{ type: "registered", browser }, { type: "authenticated", via: "password", browser: { id: browser.id, name } }],
    };
  }

  private async proof(st: Extract<DeviceState, { s: "resume_proof" }>, payload: Uint8Array): Promise<Step> {
    const opened = openData(st.channel, payload);
    if (!("control" in opened) || opened.control.t !== "proof") throw new WireError("expected proof");
    const jwk = publicJwk(opened.control.jwk);
    const signature = fromBase64(str(opened.control.sig, "sig"));
    const known = this.credentials.browsers.find((b) => sameKey(b.publicKeyJwk, jwk));
    const deny = (code: string): Step => {
      this.state = { s: "dead" };
      return { outgoing: [sealControl(st.channel, { t: "denied", code })], events: [{ type: "auth_failed", via: "key", code }] };
    };
    if (!known) return deny("unknown_browser");
    const key = await crypto.subtle.importKey("jwk", jwk, ECDSA, false, ["verify"]);
    const ok = await crypto.subtle.verify(ECDSA_SIGN, key, signature, concatBytes(PROOF_TAG, st.nonce));
    if (!ok) return deny("bad_signature");
    this.state = { s: "authed", channel: st.channel, decoder: new FrameDecoder() };
    return {
      outgoing: [sealControl(st.channel, { t: "ok", id: known.id })],
      events: [{ type: "authenticated", via: "key", browser: { id: known.id, name: known.name } }],
    };
  }

  private async application(st: Extract<DeviceState, { s: "authed" }>, payload: Uint8Array): Promise<Step> {
    const opened = openData(st.channel, payload);
    if (!("record" in opened)) throw new WireError("unexpected control after authentication");
    const message = await st.decoder.push(opened.record);
    return { outgoing: [], events: message ? [{ type: "message", message }] : [] };
  }
}

// ---- browser ----------------------------------------------------------------------------------------------------------

type BrowserState =
  | { s: "idle" }
  | { s: "pw_wait" }
  | { s: "pw_answer"; challenge: PasswordChallenge }
  | { s: "pw_reply"; noise: ReturnType<typeof createNoise> }
  | { s: "pw_device"; channel: Channel }
  | { s: "pw_registering"; channel: Channel; pin: string; keys: CryptoKeyPair; jwk: JsonWebKey }
  | { s: "resume_wait"; noise: ReturnType<typeof createNoise>; saved: SavedBrowser }
  | { s: "resume_challenge"; channel: Channel; saved: SavedBrowser }
  | { s: "resume_proof"; channel: Channel }
  | { s: "authed"; channel: Channel; decoder: FrameDecoder }
  | { s: "dead" };

/** What the device sent in PW_CHALLENGE, held until the password is known. `pin` is the device key (base64). */
interface PasswordChallenge {
  salt: Uint8Array;
  nonce: Uint8Array;
  shareB: Uint8Array;
  pin: string;
}

export interface BrowserSessionOptions {
  store: BrowserStore;
  /** What this browser calls itself on the device's authorized list. */
  name: string;
  /**
   * Without a saved record: when given, the session answers the device's challenge by itself. When omitted, it stops at a
   * `challenged` event (carrying the device key, so the user can check it first) and waits for `answer(password)`. Never persisted.
   */
  password?: string;
}

/**
 * Browser end of one relay session. `start()` once, then feed every inbound payload to `receive`. A saved record means
 * resume (no password); otherwise the password handshake runs and the new key is saved when the device acknowledges it.
 */
export class BrowserSession {
  private state: BrowserState = { s: "idle" };
  private saved: SavedBrowser | null = null;
  /** The device key from PW_CHALLENGE; the `device` key sent after the handshake must be this one. */
  private announced: Uint8Array | null = null;

  constructor(private readonly options: BrowserSessionOptions) {}

  async start(): Promise<Step> {
    if (this.state.s !== "idle") throw new WireError("session already started");
    this.saved = await this.options.store.load();
    if (this.saved) {
      const noise = createNoise({ initiator: true, pattern: "NK", prologue: RESUME_PROLOGUE, pinnedPublic: fromBase64(this.saved.pin) });
      this.state = { s: "resume_wait", noise, saved: this.saved };
      return { outgoing: [tagged(RESUME, noise.write())], events: [] };
    }
    this.state = { s: "pw_wait" };
    return { outgoing: [Uint8Array.of(PW_START)], events: [] };
  }

  /** Answers a `challenged` event with the device password. The password never leaves this call except as PAKE and Noise bytes. */
  async answer(password: string): Promise<Step> {
    const st = this.state;
    if (st.s !== "pw_answer") throw new WireError("there is no challenge to answer");
    return this.respond(st.challenge, password);
  }

  async receive(payload: Uint8Array): Promise<Step> {
    if (payload.length === 0) throw new WireError("empty payload");
    const st = this.state;
    if (st.s === "dead") throw new WireError("session is closed");
    if (payload[0] === ERROR && st.s !== "authed") return this.deviceRefused(payload);
    switch (st.s) {
      case "pw_wait":
        return this.passwordChallenge(payload);
      case "pw_answer":
        throw new WireError("the device sent data before the password was given");
      case "pw_reply":
        return this.passwordReply(st, payload);
      case "pw_device":
        return this.deviceKey(st, payload);
      case "pw_registering":
        return this.registered(st, payload);
      case "resume_wait":
        return this.resumeReply(st, payload);
      case "resume_challenge":
        return this.challenge(st, payload);
      case "resume_proof":
        return this.verdict(st, payload);
      case "authed":
        return this.application(st, payload);
      case "idle":
        throw new WireError("session not started");
    }
  }

  async send(message: WireMessage, options?: EncodeOptions): Promise<Uint8Array[]> {
    const st = this.state;
    if (st.s !== "authed") throw new WireError("session is not authenticated");
    const records = await encodeMessage(message, options);
    return records.map((r) => tagged(DATA, st.channel.seal(tagged(KIND_RECORD, r))));
  }

  private fail(via: Via, code: string): Step {
    this.state = { s: "dead" };
    return { outgoing: [], events: [{ type: "auth_failed", via, code }] };
  }

  private deviceRefused(payload: Uint8Array): Step {
    const via: Via = this.state.s.startsWith("pw_") ? "password" : "key";
    return this.fail(via, text(payload.subarray(1)));
  }

  private async passwordChallenge(payload: Uint8Array): Promise<Step> {
    if (payload[0] !== PW_CHALLENGE) throw new WireError("expected PW_CHALLENGE");
    const body = payload.subarray(1);
    const plain = SALT_BYTES + NONCE_BYTES + SHARE_BYTES;
    // A challenge without the device key comes from a device that predates the announcement. There is no fallback: it cannot connect.
    if (body.length === plain) return this.fail("password", "device_outdated");
    if (body.length !== plain + STATIC_BYTES) throw new WireError("malformed PW_CHALLENGE");
    const announced = body.slice(plain);
    this.announced = announced;
    const challenge: PasswordChallenge = {
      salt: body.slice(0, SALT_BYTES),
      nonce: body.slice(SALT_BYTES, SALT_BYTES + NONCE_BYTES),
      shareB: body.slice(SALT_BYTES + NONCE_BYTES, plain),
      pin: toBase64(announced),
    };
    if (this.options.password !== undefined) return this.respond(challenge, this.options.password);
    this.state = { s: "pw_answer", challenge };
    return { outgoing: [], events: [{ type: "challenged", pin: challenge.pin }] };
  }

  private async respond({ salt, nonce, shareB }: PasswordChallenge, password: string): Promise<Step> {
    const secret = await deriveSecret(password, toBase64(salt));
    const pake = startPake("A", secret, concatBytes(salt, nonce));
    let psk: Uint8Array;
    try {
      psk = pake.finish(shareB);
    } catch {
      throw new WireError("invalid PAKE share");
    }
    const noise = createNoise({ initiator: true, pattern: "NNpsk0", prologue: concatBytes(PW_PROLOGUE, salt, nonce), psk });
    this.state = { s: "pw_reply", noise };
    return { outgoing: [tagged(PW_FINISH, pake.share, noise.write())], events: [] };
  }

  private passwordReply(st: Extract<BrowserState, { s: "pw_reply" }>, payload: Uint8Array): Step {
    if (payload[0] !== PW_REPLY) throw new WireError("expected PW_REPLY");
    st.noise.read(payload.subarray(1));
    this.state = { s: "pw_device", channel: st.noise.split() };
    return { outgoing: [], events: [] };
  }

  private async deviceKey(st: Extract<BrowserState, { s: "pw_device" }>, payload: Uint8Array): Promise<Step> {
    const opened = openData(st.channel, payload);
    if (!("control" in opened) || opened.control.t !== "device") throw new WireError("expected the device key");
    const pin = str(opened.control.pub, "pub", 64);
    const key = fromBase64(pin);
    if (key.length !== STATIC_BYTES) throw new WireError("device key has the wrong length");
    if (!this.announced || !equalBytes(key, this.announced)) throw new WireError("the device key differs from the one in PW_CHALLENGE");
    const keys = (await crypto.subtle.generateKey(ECDSA, false, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = publicJwk(await crypto.subtle.exportKey("jwk", keys.publicKey));
    this.state = { s: "pw_registering", channel: st.channel, pin, keys, jwk };
    return {
      outgoing: [sealControl(st.channel, { t: "register", name: this.options.name, jwk })],
      events: [{ type: "pinned", pin }],
    };
  }

  private async registered(st: Extract<BrowserState, { s: "pw_registering" }>, payload: Uint8Array): Promise<Step> {
    const opened = openData(st.channel, payload);
    if (!("control" in opened) || opened.control.t !== "registered") throw new WireError("expected the registration acknowledgement");
    const id = str(opened.control.id, "id", 64);
    await this.options.store.save({ pin: st.pin, privateKey: st.keys.privateKey, publicKeyJwk: st.jwk, name: this.options.name });
    this.state = { s: "authed", channel: st.channel, decoder: new FrameDecoder() };
    return { outgoing: [], events: [{ type: "authenticated", via: "password", browser: { id, name: this.options.name } }] };
  }

  private resumeReply(st: Extract<BrowserState, { s: "resume_wait" }>, payload: Uint8Array): Step {
    if (payload[0] === PIN_CLAIM) {
      const received = toBase64(payload.subarray(1));
      this.state = { s: "dead" };
      if (equalBytes(payload.subarray(1), fromBase64(st.saved.pin))) return { outgoing: [], events: [{ type: "auth_failed", via: "key", code: "handshake" }] };
      return { outgoing: [], events: [{ type: "pin_mismatch", expected: st.saved.pin, received }] };
    }
    if (payload[0] !== RESUME_REPLY) throw new WireError("expected RESUME_REPLY");
    try {
      st.noise.read(payload.subarray(1));
    } catch {
      throw new WireError("the device did not prove the pinned key");
    }
    this.state = { s: "resume_challenge", channel: st.noise.split(), saved: st.saved };
    return { outgoing: [], events: [] };
  }

  private async challenge(st: Extract<BrowserState, { s: "resume_challenge" }>, payload: Uint8Array): Promise<Step> {
    const opened = openData(st.channel, payload);
    if (!("control" in opened) || opened.control.t !== "challenge") throw new WireError("expected a challenge");
    const nonce = fromBase64(str(opened.control.nonce, "nonce", 128));
    if (nonce.length !== CHALLENGE_BYTES) throw new WireError("challenge has the wrong length");
    const sig = new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN, st.saved.privateKey, concatBytes(PROOF_TAG, nonce)));
    this.state = { s: "resume_proof", channel: st.channel };
    return { outgoing: [sealControl(st.channel, { t: "proof", jwk: st.saved.publicKeyJwk, sig: toBase64(sig) })], events: [] };
  }

  private verdict(st: Extract<BrowserState, { s: "resume_proof" }>, payload: Uint8Array): Step {
    const opened = openData(st.channel, payload);
    if (!("control" in opened)) throw new WireError("expected a verdict");
    if (opened.control.t === "denied") return this.fail("key", str(opened.control.code, "code", 64));
    if (opened.control.t !== "ok") throw new WireError("expected a verdict");
    this.state = { s: "authed", channel: st.channel, decoder: new FrameDecoder() };
    const saved = this.saved;
    return { outgoing: [], events: [{ type: "authenticated", via: "key", browser: { id: str(opened.control.id, "id", 64), name: saved?.name ?? this.options.name } }] };
  }

  private async application(st: Extract<BrowserState, { s: "authed" }>, payload: Uint8Array): Promise<Step> {
    const opened = openData(st.channel, payload);
    if (!("record" in opened)) throw new WireError("unexpected control after authentication");
    const message = await st.decoder.push(opened.record);
    return { outgoing: [], events: message ? [{ type: "message", message }] : [] };
  }
}
