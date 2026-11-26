// Device side of every relay session (ADR 0036): one wire DeviceSession per relay `sid`, the single controller with its
// busy/takeover rules, and the post-authentication routing of the controller's messages to the session host. This file
// owns ordering (calls into a session are serialized; events are applied before their outgoing bytes are forwarded),
// bounds on unauthenticated work, and which session may reach the host.
import type { Host } from "../host/index.ts";
import { DeviceSession, type AuthorizedBrowser, type DeviceCredentials, type WireEvent, type WireMessage } from "../wire/index.ts";

/** Sessions that have not authenticated yet. Opens beyond this are hung up at once. */
export const MAX_PENDING = 8;
/** All sessions, authenticated or not. */
export const MAX_SESSIONS = 32;
/** Inbound bytes a session may send before it authenticates. */
export const MAX_PRE_AUTH_BYTES = 64 * 1024;
/** Inbound payloads waiting to be processed per session. Beyond this the session is hung up. */
export const MAX_QUEUED = 256;
export const HANDSHAKE_TIMEOUT_MS = 20_000;

export interface SessionsOptions {
  credentials(): DeviceCredentials;
  /** Epoch ms until which new password handshakes are refused. */
  lockedUntil(): number;
  /** A password attempt failed (wrong password); awaited before the failure reaches the browser. */
  failure(): Promise<void>;
  /** A password attempt succeeded. */
  success(): Promise<void>;
  /** A browser proved the password and sent its key; persist it before the browser is told it is registered. */
  authorize(browser: AuthorizedBrowser): Promise<void>;
  /** Writes bytes to the relay session `sid`. */
  send(sid: string, bytes: Uint8Array): void;
  /** Asks the relay to close `sid`; not called when the relay itself closed it. */
  hangup(sid: string): void;
  host: Host;
  now?: () => number;
  handshakeTimeoutMs?: number;
}

type Phase = "pre" | "waiting" | "control";

interface Session {
  sid: string;
  device: DeviceSession;
  phase: Phase;
  browser?: { id: string; name: string };
  /** Serializes inbound payloads. */
  inbound: Promise<void>;
  queued: number;
  preBytes: number;
  /** Serializes outbound messages, so records of two messages never interleave. */
  outbound: Promise<void>;
  /** Host streams this session opened, by the browser's cid. */
  cids: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
  /** This session holds the one in-flight password attempt. */
  attempting: boolean;
}

export interface SessionsStatus {
  sessions: number;
  authenticated: number;
  controller: string | null;
}

export class Sessions {
  readonly #o: SessionsOptions;
  readonly #sessions = new Map<string, Session>();
  #controller: Session | null = null;
  #attempt: Session | null = null;

  constructor(options: SessionsOptions) {
    this.#o = options;
  }

  status(): SessionsStatus {
    let authenticated = 0;
    for (const s of this.#sessions.values()) if (s.phase !== "pre") authenticated++;
    return { sessions: this.#sessions.size, authenticated, controller: this.#controller?.browser?.name ?? null };
  }

  /** The relay opened session `sid`. */
  open(sid: string): void {
    if (this.#sessions.has(sid)) return;
    const pending = [...this.#sessions.values()].filter((s) => s.phase === "pre").length;
    if (pending >= MAX_PENDING || this.#sessions.size >= MAX_SESSIONS) {
      this.#o.hangup(sid);
      return;
    }
    const s: Session = {
      sid,
      device: new DeviceSession({
        credentials: this.#o.credentials(),
        now: this.#o.now,
        passwordAllowed: () => this.#passwordAllowed(s),
      }),
      phase: "pre",
      inbound: Promise.resolve(),
      queued: 0,
      preBytes: 0,
      outbound: Promise.resolve(),
      cids: new Set(),
      timer: null,
      dead: false,
      attempting: false,
    };
    s.timer = setTimeout(() => {
      if (s.phase === "pre") this.#end(s, true);
    }, this.#o.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    s.timer.unref?.();
    this.#sessions.set(sid, s);
  }

  /** Payload bytes from the browser behind `sid`. */
  data(sid: string, bytes: Uint8Array): void {
    const s = this.#sessions.get(sid);
    if (!s || s.dead) return;
    if (s.phase === "pre") {
      s.preBytes += bytes.length;
      if (s.preBytes > MAX_PRE_AUTH_BYTES) return this.#end(s, true);
    }
    if (s.queued >= MAX_QUEUED) return this.#end(s, true);
    s.queued++;
    s.inbound = s.inbound.then(() => this.#process(s, bytes)).finally(() => {
      s.queued--;
    });
  }

  /** The relay closed `sid` (the browser left, or the link dropped). */
  close(sid: string): void {
    const s = this.#sessions.get(sid);
    if (s) this.#end(s, false);
  }

  /** Ends every session: the device is stopping, or its credentials changed. */
  closeAll(): void {
    for (const s of [...this.#sessions.values()]) this.#end(s, true);
  }

  /** Ends the sessions of one browser, after it was revoked. */
  revoke(browserId: string): void {
    for (const s of [...this.#sessions.values()]) if (s.browser?.id === browserId) this.#end(s, true);
  }

  #passwordAllowed(s: Session): boolean {
    const now = (this.#o.now ?? Date.now)();
    if (now < this.#o.lockedUntil()) return false;
    // One password attempt at a time: parallel handshakes must not outrun the failure counter.
    if (this.#attempt && this.#attempt !== s) return false;
    this.#attempt = s;
    s.attempting = true;
    return true;
  }

  async #process(s: Session, bytes: Uint8Array): Promise<void> {
    if (s.dead) return;
    try {
      const step = await s.device.receive(bytes);
      // Persist and count before anything reaches the browser.
      for (const event of step.events) await this.#apply(s, event);
      if (s.dead) return;
      for (const out of step.outgoing) this.#o.send(s.sid, out);
      for (const event of step.events) if (event.type === "authenticated") await this.#grantOrWait(s);
      for (const event of step.events) if (event.type === "message") this.#route(s, event.message);
    } catch {
      this.#end(s, true);
    }
  }

  async #apply(s: Session, event: WireEvent): Promise<void> {
    switch (event.type) {
      case "registered":
        await this.#o.authorize(event.browser);
        return;
      case "auth_failed":
        this.#attemptDone(s);
        if (event.via === "password" && event.code === "bad_password") await this.#o.failure();
        // The device has already refused; end the session once the refusal was forwarded.
        setTimeout(() => this.#end(s, true), 200).unref?.();
        return;
      case "authenticated":
        if (event.via === "password") {
          this.#attemptDone(s);
          await this.#o.success();
        }
        s.browser = event.browser;
        s.phase = "waiting";
        if (s.timer) clearTimeout(s.timer);
        s.timer = null;
        return;
      default:
        return;
    }
  }

  #attemptDone(s: Session): void {
    if (this.#attempt === s) this.#attempt = null;
    s.attempting = false;
  }

  async #grantOrWait(s: Session): Promise<void> {
    const holder = this.#controller;
    if (holder && holder !== s) {
      await this.#send(s, { k: "busy", by: holder.browser?.name ?? "another browser" });
      return;
    }
    await this.#grant(s);
  }

  async #grant(s: Session): Promise<void> {
    this.#controller = s;
    s.phase = "control";
    await this.#send(s, { k: "hello", proto: 1 });
  }

  async #takeover(s: Session): Promise<void> {
    const old = this.#controller;
    if (old === s) return;
    if (old) {
      this.#release(old);
      old.phase = "waiting";
      await this.#send(old, { k: "taken_over", by: s.browser?.name ?? "another browser" });
      setTimeout(() => this.#end(old, true), 200).unref?.();
    }
    await this.#grant(s);
  }

  #route(s: Session, message: WireMessage): void {
    if (s.phase === "waiting") {
      if (message.k === "takeover") void this.#takeover(s).catch(() => this.#end(s, true));
      return;
    }
    if (s.phase !== "control") return;
    switch (message.k) {
      case "req":
        void this.#o.host.request({ method: message.method, path: message.path, body: message.body }).then((res) =>
          this.#send(s, { k: "res", id: message.id, status: res.status, body: res.body }),
        );
        return;
      case "open": {
        const key = this.#key(s, message.cid);
        s.cids.add(message.cid);
        this.#o.host.open(key, message.path, {
          onOpen: () => void this.#send(s, { k: "ready", cid: message.cid }),
          onFrame: (_k, text) => void this.#send(s, { k: "frame", cid: message.cid, text }),
          onClose: (_k, reason) => {
            s.cids.delete(message.cid);
            void this.#send(s, { k: "close", cid: message.cid, reason });
          },
        });
        return;
      }
      case "frame":
        if (s.cids.has(message.cid)) this.#o.host.frame(this.#key(s, message.cid), message.text);
        return;
      case "close":
        if (s.cids.delete(message.cid)) this.#o.host.close(this.#key(s, message.cid));
        return;
      default:
        return;
    }
  }

  #key(s: Session, cid: string): string {
    return `${s.sid}:${cid}`;
  }

  /** Drops what `s` holds on the host. Running tasks keep running; only the routing ends. */
  #release(s: Session): void {
    for (const cid of s.cids) this.#o.host.close(this.#key(s, cid));
    s.cids.clear();
    if (this.#controller === s) this.#controller = null;
  }

  #send(s: Session, message: WireMessage): Promise<void> {
    const run = s.outbound.then(async () => {
      if (s.dead) return;
      for (const payload of await s.device.send(message)) this.#o.send(s.sid, payload);
    });
    s.outbound = run.catch(() => {});
    return run.catch(() => this.#end(s, true));
  }

  #end(s: Session, hangup: boolean): void {
    if (s.dead) return;
    s.dead = true;
    if (s.timer) clearTimeout(s.timer);
    this.#attemptDone(s);
    this.#release(s);
    this.#sessions.delete(s.sid);
    if (hangup) this.#o.hangup(s.sid);
  }
}
