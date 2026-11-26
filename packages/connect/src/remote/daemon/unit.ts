// One device's remote access inside the omp daemon (ADR 0025, 0036): the persistent switch and credentials, the outbound
// relay link, the sessions behind it and the session host. Everything is injected so it runs and tests without omp.
// The omp-facing shell is module.ts.
import { createHost, type ChildStatus, type Host, type HostOptions } from "../host/index.ts";
import { DeviceRelay, remoteApi, type RelayAccount, type RelayCallbacks } from "./relay.ts";
import { Sessions, type SessionsStatus } from "./sessions.ts";
import { LiveRegistry, type LiveTunnel } from "./live.ts";
import { RemoteStateFile, type RemoteState } from "./store.ts";
import {
  addBrowser,
  changePassword,
  createPasswordVerifier,
  fingerprint,
  forgetCredentials,
  fromBase64,
  revokeBrowser,
  type PasswordVerifier,
} from "../wire/index.ts";
import { lockDurationMs } from "./store.ts";

/** What the omp process knows and the daemon must not guess: the account, the device and how to launch a session. */
export interface Configure {
  baseUrl: string;
  clientSecret: string;
  deviceName: string;
  agentDir: string;
  /** The omp command for a session: `[cgs, "--mode", "rpc-ui"]`. */
  command: string[];
  env: Record<string, string>;
  /** Proxy for the relay WebSocket, when the network needs one. */
  proxy?: string;
}

export interface Link {
  readonly online: boolean;
  start(): void;
  stop(): void;
  send(sid: string, bytes: Uint8Array): void;
  /** Ends relay session `sid` from the device side. */
  hangup(sid: string): void;
}

export interface UnitDeps {
  file: string;
  createHost(options: HostOptions): Host;
  createLink(account: RelayAccount & { proxy?: string }, callbacks: RelayCallbacks): Link;
  api(account: RelayAccount, enabled?: boolean): Promise<{ allowed: boolean; enabled: boolean }>;
  createVerifier(password: string): Promise<PasswordVerifier>;
  now(): number;
}

export function defaultDeps(file: string): UnitDeps {
  return {
    file,
    createHost: createHost,
    createLink: (account, callbacks) => new DeviceRelay(account, callbacks),
    api: remoteApi,
    createVerifier: createPasswordVerifier,
    now: Date.now,
  };
}

/** Close codes that end the link for good: the account, the device or the entitlement is gone. */
const FATAL_CLOSE: Record<number, true> = { 4401: true, 4403: true, 4404: true };
const CLOSE_NOT_ENABLED = 4409;

export interface UnitStatus {
  configured: boolean;
  enabled: boolean;
  hasPassword: boolean;
  online: boolean;
  /** The relay refused the device with this close code and the link was stopped. */
  refused: number | null;
  sessions: SessionsStatus;
  lock: { failures: number; until: number };
  browsers: { id: string; name: string; addedAt: number }[];
  fingerprint: ReturnType<typeof fingerprint>;
}

export class RemoteUnit {
  readonly #deps: UnitDeps;
  readonly #file: RemoteStateFile;
  #cfg: Configure | null = null;
  #link: Link | null = null;
  #host: Host | null = null;
  #refused: number | null = null;
  #state: RemoteState | null = null;
  readonly #sessions: Sessions;
  readonly #live = new LiveRegistry(() => this.#cfg?.deviceName ?? "this computer");

  constructor(deps: UnitDeps) {
    this.#deps = deps;
    this.#file = new RemoteStateFile(deps.file);
    this.#sessions = new Sessions({
      credentials: () => this.#current().credentials,
      lockedUntil: () => this.#current().lock.until,
      failure: () => this.#countFailure(),
      success: () => this.#clearFailures(),
      authorize: async (browser) => {
        this.#state = await this.#file.update((s) => {
          s.credentials = addBrowser(s.credentials, browser);
        });
      },
      send: (sid, bytes) => this.#link?.send(sid, bytes),
      hangup: (sid) => this.#link?.hangup(sid),
      host: this.#lazyHost(),
      now: deps.now,
    });
  }

  /** Loads the persisted state; call once before use. Starts the link when the device switch is already on. */
  async init(): Promise<void> {
    this.#state = await this.#file.read();
  }

  async configure(cfg: Configure): Promise<UnitStatus> {
    const changed = !this.#cfg || this.#cfg.baseUrl !== cfg.baseUrl || this.#cfg.clientSecret !== cfg.clientSecret || this.#cfg.proxy !== cfg.proxy;
    this.#cfg = cfg;
    if (changed) {
      this.#refused = null;
      this.#stopLink();
    }
    await this.#syncLink();
    return this.status();
  }

  /** The account's remote entitlement and the server's view of this device's switch. */
  entitlement(): Promise<{ allowed: boolean; enabled: boolean }> {
    return this.#deps.api(this.#account());
  }

  /** Turns remote on. The server decides entitlement (403 `remote_not_allowed`); a password must exist first. */
  async enable(): Promise<UnitStatus> {
    if (!this.#current().credentials.verifier) throw new Error("password_required");
    await this.#deps.api(this.#account(), true);
    this.#state = await this.#file.update((s) => {
      s.enabled = true;
    });
    this.#refused = null;
    await this.#syncLink();
    return this.status();
  }

  async disable(): Promise<UnitStatus & { serverNotified: boolean }> {
    this.#state = await this.#file.update((s) => {
      s.enabled = false;
    });
    this.#stopLink();
    let serverNotified = true;
    try {
      await this.#deps.api(this.#account(), false);
    } catch {
      serverNotified = false;
    }
    return { ...(await this.status()), serverNotified };
  }

  /** Sets a new password. Every authorized browser stops working (ADR 0036 section 5). */
  async setPassword(password: string): Promise<UnitStatus> {
    const verifier = await this.#deps.createVerifier(password);
    this.#state = await this.#file.update((s) => {
      s.credentials = changePassword(s.credentials, verifier);
      s.lock = { failures: 0, until: 0 };
    });
    this.#sessions.closeAll();
    return this.status();
  }

  /** `/connect forget`: no password, no browsers, switch off. */
  async forget(): Promise<UnitStatus> {
    this.#state = await this.#file.update((s) => {
      s.credentials = forgetCredentials(s.credentials);
      s.enabled = false;
      s.lock = { failures: 0, until: 0 };
    });
    this.#stopLink();
    await this.#deps.api(this.#account(), false).catch(() => {});
    return this.status();
  }

  async revokeBrowser(id: string): Promise<UnitStatus> {
    this.#state = await this.#file.update((s) => {
      s.credentials = revokeBrowser(s.credentials, id);
    });
    this.#sessions.revoke(id);
    return this.status();
  }

  async unlock(): Promise<UnitStatus> {
    this.#state = await this.#file.update((s) => {
      s.lock = { failures: 0, until: 0 };
    });
    return this.status();
  }

  async status(): Promise<UnitStatus> {
    const s = await this.#file.read();
    this.#state = s;
    return {
      configured: this.#cfg !== null,
      enabled: s.enabled,
      hasPassword: s.credentials.verifier !== null,
      online: this.#link?.online ?? false,
      refused: this.#refused,
      sessions: this.#sessions.status(),
      lock: { ...s.lock },
      browsers: s.credentials.browsers.map((b) => ({ id: b.id, name: b.name, addedAt: b.addedAt })),
      fingerprint: fingerprint(fromBase64(s.credentials.staticKey.publicKey)),
    };
  }

  /** In-flight work: a unit with a signed-in browser is never idle-stopped. */
  busy(): boolean {
    return this.#sessions.status().authenticated > 0;
  }

  /** A TUI on this device stands by as a live session (ADR 0027). Refused unless remote access is on. */
  attachLive(tunnel: LiveTunnel, channel: string | undefined): void {
    this.#live.attach(channel ?? "", tunnel, this.#state?.enabled === true);
  }

  async stop(): Promise<void> {
    this.#stopLink();
    await this.#host?.shutdown();
    this.#host = null;
  }

  #current(): RemoteState {
    if (!this.#state) throw new Error("unit not initialized");
    return this.#state;
  }

  #account(): RelayAccount {
    if (!this.#cfg) throw new Error("not_configured");
    return { baseUrl: this.#cfg.baseUrl, clientSecret: this.#cfg.clientSecret };
  }

  /** The session host is created on first use: a device nobody connects to never spawns an omp child. */
  #lazyHost(): Host {
    const ensure = (): Host => {
      if (this.#host) return this.#host;
      const cfg = this.#cfg;
      if (!cfg) throw new Error("not_configured");
      this.#host = this.#deps.createHost({ agentDir: cfg.agentDir, device: cfg.deviceName, command: cfg.command, env: cfg.env });
      return this.#host;
    };
    return {
      request: async (req) => {
        const url = new URL(req.path, "http://host.invalid");
        if (url.pathname === "/api/children" && req.method === "POST") {
          // A session file a live terminal already runs is that terminal: the browser joins it, no second child spawns.
          const body: unknown = req.body;
          const file = typeof body === "object" && body !== null && "sessionPath" in body ? body.sessionPath : undefined;
          const live = typeof file === "string" ? this.#live.findBySession(file) : undefined;
          if (live) return { status: 200, body: live };
        }
        const res = await ensure().request(req);
        if (req.method !== "GET" || url.pathname !== "/api/children") return res;
        const body: unknown = res.body;
        if (typeof body !== "object" || body === null || !("children" in body) || !Array.isArray(body.children)) return res;
        const live = this.#live.list();
        const liveFiles = new Set(live.map((c) => c.sessionPath));
        const children = (body.children as ChildStatus[]).filter((c) => c.sessionPath === undefined || !liveFiles.has(c.sessionPath));
        return { ...res, body: { ...body, children: [...children, ...live] } };
      },
      open: (cid, path, handlers) => {
        if (!this.#live.open(cid, path, handlers)) ensure().open(cid, path, handlers);
      },
      frame: (cid, text) => {
        if (!this.#live.frame(cid, text)) ensure().frame(cid, text);
      },
      close: (cid) => {
        if (!this.#live.close(cid)) this.#host?.close(cid);
      },
      shutdown: async () => this.#host?.shutdown(),
    };
  }

  async #syncLink(): Promise<void> {
    const s = this.#current();
    const want = this.#cfg !== null && s.enabled && s.credentials.verifier !== null && this.#refused === null;
    if (!want) {
      this.#stopLink();
      return;
    }
    if (this.#link) return;
    const cfg = this.#cfg!;
    const link = this.#deps.createLink(
      { baseUrl: cfg.baseUrl, clientSecret: cfg.clientSecret, proxy: cfg.proxy },
      {
        open: (sid) => this.#sessions.open(sid),
        data: (sid, bytes) => this.#sessions.data(sid, bytes),
        close: (sid) => this.#sessions.close(sid),
        disconnected: (code) => void this.#disconnected(link, code),
      },
    );
    this.#link = link;
    link.start();
  }

  #stopLink(): void {
    const link = this.#link;
    this.#link = null;
    this.#sessions.closeAll();
    this.#live.closeAll();
    link?.stop();
  }

  async #disconnected(link: Link, code: number): Promise<void> {
    if (this.#link !== link) return;
    if (FATAL_CLOSE[code]) {
      this.#refused = code;
      this.#stopLink();
      return;
    }
    if (code === CLOSE_NOT_ENABLED) {
      // The server forgot the switch (it was reset or turned off remotely): put it back, or give up if it refuses.
      try {
        await this.#deps.api(this.#account(), true);
      } catch {
        this.#refused = CLOSE_NOT_ENABLED;
        this.#stopLink();
      }
    }
  }

  async #countFailure(): Promise<void> {
    this.#state = await this.#file.update((s) => {
      s.lock.failures += 1;
      const lock = lockDurationMs(s.lock.failures);
      if (lock > 0) s.lock.until = this.#deps.now() + lock;
    });
  }

  async #clearFailures(): Promise<void> {
    if (this.#current().lock.failures === 0 && this.#current().lock.until === 0) return;
    this.#state = await this.#file.update((s) => {
      s.lock = { failures: 0, until: 0 };
    });
  }
}

