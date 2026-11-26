// The device's persistent remote state (ADR 0036): the switch, the credentials and the password lockout. One daemon unit
// owns the file, so writes are serialized here and never race another writer. The file holds the device private key and
// the password verifier (password-equivalent): owner-only permissions, temp file then rename.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeviceCredentials, type DeviceCredentials } from "../wire/index.ts";

export const LOCK_THRESHOLD = 5;
export const LOCK_BASE_MS = 60_000;
export const LOCK_CAP_MS = 15 * 60_000;

export interface Lockout {
  /** Consecutive wrong passwords; reset by a correct one or `/connect unlock`. */
  failures: number;
  /** Epoch ms until which password handshakes are refused; 0 when not locked. */
  until: number;
}

export interface RemoteState {
  v: 1;
  /** The device switch: `/connect` turns it on, `/connect off` turns it off. Survives restarts. */
  enabled: boolean;
  credentials: DeviceCredentials;
  lock: Lockout;
}

/** Lock duration after `failures` consecutive wrong passwords: none below 5, then 1 min doubling to 15 min. */
export function lockDurationMs(failures: number): number {
  if (failures < LOCK_THRESHOLD) return 0;
  return Math.min(LOCK_CAP_MS, LOCK_BASE_MS * 2 ** (failures - LOCK_THRESHOLD));
}

export function freshState(): RemoteState {
  return { v: 1, enabled: false, credentials: createDeviceCredentials(null), lock: { failures: 0, until: 0 } };
}

function parse(text: string): RemoteState | null {
  try {
    const s = JSON.parse(text) as Partial<RemoteState>;
    if (s.v !== 1 || typeof s.enabled !== "boolean" || !s.credentials?.staticKey || !Array.isArray(s.credentials.browsers)) return null;
    const lock = s.lock ?? { failures: 0, until: 0 };
    return { v: 1, enabled: s.enabled, credentials: s.credentials, lock: { failures: Number(lock.failures) || 0, until: Number(lock.until) || 0 } };
  } catch {
    return null;
  }
}

/** Serialized, atomic access to one state file. */
export class RemoteStateFile {
  #queue: Promise<unknown> = Promise.resolve();
  #state: RemoteState | null = null;

  constructor(readonly file: string) {}

  /** The current state; a missing or unreadable file starts fresh (a new device key) and is written back. */
  async read(): Promise<RemoteState> {
    if (this.#state) return this.#state;
    let text: string | null = null;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch {
      /* first run */
    }
    this.#state = (text && parse(text)) || freshState();
    if (!text) await this.#write(this.#state);
    return this.#state;
  }

  /** Applies `change` to a copy of the state and persists the result before returning it. */
  update(change: (state: RemoteState) => RemoteState | void): Promise<RemoteState> {
    const run = this.#queue.then(async () => {
      const current = await this.read();
      const draft = structuredClone(current);
      const next = change(draft) ?? draft;
      await this.#write(next);
      this.#state = next;
      return next;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #write(state: RemoteState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.file);
  }
}
