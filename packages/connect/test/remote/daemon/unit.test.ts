import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Host, SocketHandlers } from "../../../src/remote/host/index.ts";
import type { RelayCallbacks } from "../../../src/remote/daemon/relay.ts";
import { RemoteUnit, type Configure, type Link, type UnitDeps } from "../../../src/remote/daemon/unit.ts";
import { BrowserSession, createPasswordVerifier, type BrowserStore, type PasswordVerifier, type SavedBrowser, type Step, type WireMessage } from "../../../src/remote/wire/index.ts";

const PASSWORD = "correct horse battery staple";
let verifier: PasswordVerifier;
beforeAll(async () => {
  verifier = await createPasswordVerifier(PASSWORD);
});

const CFG: Configure = { baseUrl: "https://relay.example", clientSecret: "cgc_test", deviceName: "Test PC", agentDir: "/agent", command: ["cgs"], env: {} };

class MemoryStore implements BrowserStore {
  saved: SavedBrowser | null = null;
  async load() {
    return this.saved;
  }
  async save(value: SavedBrowser) {
    this.saved = value;
  }
}

class FakeLink implements Link {
  online = true;
  started = false;
  stopped = false;
  toBrowser: { sid: string; bytes: Uint8Array }[] = [];
  hungUp: string[] = [];
  constructor(readonly cb: RelayCallbacks) {}
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.online = false;
  }
  send(sid: string, bytes: Uint8Array) {
    this.toBrowser.push({ sid, bytes });
  }
  hangup(sid: string) {
    this.hungUp.push(sid);
  }
}

class FakeHost implements Host {
  requests: { method: string; path: string }[] = [];
  streams = new Map<string, SocketHandlers>();
  async request(req: { method: string; path: string }) {
    this.requests.push(req);
    // Like the real host: optional fields are present as undefined, which JSON would drop.
    return { status: 200, body: { echo: req.path, title: undefined } };
  }
  open(cid: string, _path: string, handlers: SocketHandlers) {
    this.streams.set(cid, handlers);
    handlers.onOpen(cid);
  }
  frame(cid: string, text: string) {
    this.streams.get(cid)?.onFrame(cid, `echo:${text}`);
  }
  close(cid: string) {
    this.streams.delete(cid);
  }
  async shutdown() {}
}

interface World {
  unit: RemoteUnit;
  links: FakeLink[];
  host: FakeHost;
  api: { calls: (boolean | undefined)[]; refuse: boolean };
  clock: { now: number };
  file: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function world(file?: string): Promise<World> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-unit-"));
  dirs.push(dir);
  const stateFile = file ?? path.join(dir, "remote.json");
  const links: FakeLink[] = [];
  const host = new FakeHost();
  const api = { calls: [] as (boolean | undefined)[], refuse: false };
  const clock = { now: 1_000_000 };
  const deps: UnitDeps = {
    file: stateFile,
    createHost: () => host,
    createLink: (_account, cb) => {
      const link = new FakeLink(cb);
      links.push(link);
      return link;
    },
    api: async (_account, enabled) => {
      api.calls.push(enabled);
      if (enabled === true && api.refuse) throw new Error("remote_not_allowed");
      return { allowed: !api.refuse, enabled: enabled ?? false };
    },
    createVerifier: async () => verifier,
    now: () => clock.now,
  };
  const unit = new RemoteUnit(deps);
  await unit.init();
  return { unit, links, host, api, clock, file: stateFile };
}

/** A browser attached to the link as relay session `sid`, speaking through the unit's callbacks. */
class Browser {
  messages: WireMessage[] = [];
  events: Step["events"] = [];
  session: BrowserSession;
  private inbox = 0;
  constructor(
    private link: FakeLink,
    readonly sid: string,
    readonly store: BrowserStore,
    readonly name: string,
    password: string | undefined,
  ) {
    this.session = new BrowserSession({ store, name, password });
  }
  private async feed(step: Step): Promise<void> {
    for (const e of step.events) {
      this.events.push(e);
      if (e.type === "message") this.messages.push(e.message);
    }
    for (const out of step.outgoing) this.link.cb.data(this.sid, out);
  }
  /** Delivers everything the device sent since the last call, repeating until quiet. */
  async pump(): Promise<void> {
    for (let round = 0; round < 40; round++) {
      await Bun.sleep(15);
      const mine = this.link.toBrowser.filter((m) => m.sid === this.sid);
      if (mine.length <= this.inbox) {
        if (round > 3) return;
        continue;
      }
      const fresh = mine.slice(this.inbox);
      this.inbox = mine.length;
      for (const m of fresh) {
        try {
          await this.feed(await this.session.receive(m.bytes));
        } catch {
          return;
        }
      }
    }
  }
  async connect(): Promise<void> {
    this.link.cb.open(this.sid);
    await this.feed(await this.session.start());
    await this.pump();
  }
  async say(message: WireMessage): Promise<void> {
    for (const payload of await this.session.send(message)) this.link.cb.data(this.sid, payload);
    await this.pump();
  }
  types(): string[] {
    return this.events.map((e) => e.type).filter((t) => t !== "message");
  }
  got(k: WireMessage["k"]): WireMessage | undefined {
    return this.messages.find((m) => m.k === k);
  }
}

async function enabledWorld(): Promise<World> {
  const w = await world();
  await w.unit.configure(CFG);
  await w.unit.setPassword(PASSWORD);
  await w.unit.enable();
  return w;
}

describe("the device switch", () => {
  test("enabling needs a password first, and the server's refusal leaves the switch off", async () => {
    const w = await world();
    await w.unit.configure(CFG);
    await expect(w.unit.enable()).rejects.toThrow("password_required");

    await w.unit.setPassword(PASSWORD);
    w.api.refuse = true;
    await expect(w.unit.enable()).rejects.toThrow("remote_not_allowed");
    expect((await w.unit.status()).enabled).toBe(false);
    expect(w.links).toHaveLength(0);
  });

  test("enable starts the link, disable stops it and tells the server", async () => {
    const w = await enabledWorld();
    expect(w.api.calls).toEqual([true]);
    expect(w.links).toHaveLength(1);
    expect(w.links[0]!.started).toBe(true);

    const off = await w.unit.disable();
    expect(off.enabled).toBe(false);
    expect(off.serverNotified).toBe(true);
    expect(w.links[0]!.stopped).toBe(true);
    expect(w.api.calls).toEqual([true, false]);
  });

  test("the switch survives a restart: a new unit over the same file goes online on configure", async () => {
    const first = await enabledWorld();
    const second = await world(first.file);
    expect((await second.unit.status()).enabled).toBe(true);
    await second.unit.configure(CFG);
    expect(second.links).toHaveLength(1);
    expect(second.links[0]!.started).toBe(true);
  });

  test("the state file is private", async () => {
    const w = await enabledWorld();
    expect(fs.statSync(w.file).mode & 0o777).toBe(0o600);
  });

  test("a fatal close from the relay stops the link and is reported", async () => {
    const w = await enabledWorld();
    w.links[0]!.cb.disconnected(4403);
    await Bun.sleep(10);
    const status = await w.unit.status();
    expect(status.refused).toBe(4403);
    expect(w.links[0]!.stopped).toBe(true);
  });

  test("forget removes the password and every browser and switches off", async () => {
    const w = await enabledWorld();
    const b = new Browser(w.links[0]!, "s1", new MemoryStore(), "Laptop", PASSWORD);
    await b.connect();
    expect((await w.unit.status()).browsers).toHaveLength(1);

    const status = await w.unit.forget();
    expect(status).toMatchObject({ enabled: false, hasPassword: false, browsers: [] });
  });
});

describe("a browser connecting", () => {
  test("the first connection authenticates by password, gets control and reaches the host", async () => {
    const w = await enabledWorld();
    const b = new Browser(w.links[0]!, "s1", new MemoryStore(), "Laptop", PASSWORD);
    await b.connect();

    expect(b.types()).toEqual(["pinned", "authenticated"]);
    expect(b.got("hello")).toEqual({ k: "hello", proto: 1 });
    expect((await w.unit.status()).browsers.map((x) => x.name)).toEqual(["Laptop"]);

    await b.say({ k: "req", id: "1", method: "GET", path: "/api/info" });
    expect(b.got("res")).toEqual({ k: "res", id: "1", status: 200, body: { echo: "/api/info" } });

    await b.say({ k: "open", cid: "c1", path: "/ws?child=abc" });
    expect(b.got("ready")).toEqual({ k: "ready", cid: "c1" });
    await b.say({ k: "frame", cid: "c1", text: "ping" });
    expect(b.messages.find((m) => m.k === "frame")).toEqual({ k: "frame", cid: "c1", text: "echo:ping" });
  });

  test("later connections resume by key without a password", async () => {
    const w = await enabledWorld();
    const store = new MemoryStore();
    await new Browser(w.links[0]!, "s1", store, "Laptop", PASSWORD).connect();
    w.links[0]!.cb.close("s1");

    const again = new Browser(w.links[0]!, "s2", store, "Laptop", undefined);
    await again.connect();
    expect(again.types()).toEqual(["authenticated"]);
    expect(again.got("hello")).toBeDefined();
  });

  test("a revoked browser is denied on its next connection", async () => {
    const w = await enabledWorld();
    const store = new MemoryStore();
    await new Browser(w.links[0]!, "s1", store, "Laptop", PASSWORD).connect();
    const [saved] = (await w.unit.status()).browsers;
    await w.unit.revokeBrowser(saved!.id);
    expect(w.links[0]!.hungUp).toContain("s1");

    const again = new Browser(w.links[0]!, "s2", store, "Laptop", undefined);
    await again.connect();
    expect(again.events).toContainEqual({ type: "auth_failed", via: "key", code: "unknown_browser" });
  });

  test("changing the password invalidates every authorized browser", async () => {
    const w = await enabledWorld();
    const store = new MemoryStore();
    await new Browser(w.links[0]!, "s1", store, "Laptop", PASSWORD).connect();
    await w.unit.setPassword(PASSWORD);

    const again = new Browser(w.links[0]!, "s2", store, "Laptop", undefined);
    await again.connect();
    expect(again.events).toContainEqual({ type: "auth_failed", via: "key", code: "unknown_browser" });
  });
});

describe("one controller at a time", () => {
  test("a second browser is told the session is busy and can take it over", async () => {
    const w = await enabledWorld();
    const first = new Browser(w.links[0]!, "s1", new MemoryStore(), "Laptop", PASSWORD);
    await first.connect();
    const second = new Browser(w.links[0]!, "s2", new MemoryStore(), "Phone", PASSWORD);
    await second.connect();

    expect(second.got("busy")).toEqual({ k: "busy", by: "Laptop" });
    expect(second.got("hello")).toBeUndefined();
    await second.say({ k: "req", id: "x", method: "GET", path: "/api/info" });
    expect(second.got("res")).toBeUndefined();

    await second.say({ k: "takeover" });
    expect(second.got("hello")).toBeDefined();
    await first.pump();
    expect(first.got("taken_over")).toEqual({ k: "taken_over", by: "Phone" });

    await second.say({ k: "req", id: "2", method: "GET", path: "/api/children" });
    expect(second.got("res")).toMatchObject({ k: "res", id: "2" });
    await Bun.sleep(300);
    expect(w.links[0]!.hungUp).toContain("s1");
  });

  test("the old controller's host streams are released on takeover, the new one's are not", async () => {
    const w = await enabledWorld();
    const first = new Browser(w.links[0]!, "s1", new MemoryStore(), "Laptop", PASSWORD);
    await first.connect();
    await first.say({ k: "open", cid: "c1", path: "/ws?child=a" });
    expect([...w.host.streams.keys()]).toEqual(["s1:c1"]);

    const second = new Browser(w.links[0]!, "s2", new MemoryStore(), "Phone", PASSWORD);
    await second.connect();
    await second.say({ k: "takeover" });
    expect([...w.host.streams.keys()]).toEqual([]);
  });

  test("when the controller leaves, the next browser to connect gets control", async () => {
    const w = await enabledWorld();
    const first = new Browser(w.links[0]!, "s1", new MemoryStore(), "Laptop", PASSWORD);
    await first.connect();
    w.links[0]!.cb.close("s1");

    const second = new Browser(w.links[0]!, "s2", new MemoryStore(), "Phone", PASSWORD);
    await second.connect();
    expect(second.got("hello")).toBeDefined();
    expect(second.got("busy")).toBeUndefined();
  });
});

describe("password lockout", () => {
  test("five wrong passwords lock the device; unlock clears it; success resets the count", async () => {
    const w = await enabledWorld();
    for (let i = 0; i < 5; i++) {
      const bad = new Browser(w.links[0]!, `bad${i}`, new MemoryStore(), "Bad", "wrong");
      await bad.connect();
      expect(bad.events).toContainEqual({ type: "auth_failed", via: "password", code: "bad_password" });
    }
    const locked = await w.unit.status();
    expect(locked.lock.failures).toBe(5);
    expect(locked.lock.until).toBe(w.clock.now + 60_000);

    const refused = new Browser(w.links[0]!, "refused", new MemoryStore(), "Right password", PASSWORD);
    await refused.connect();
    expect(refused.events).toContainEqual({ type: "auth_failed", via: "password", code: "locked" });
    expect((await w.unit.status()).lock.failures).toBe(5);

    w.clock.now += 61_000;
    const ok = new Browser(w.links[0]!, "ok", new MemoryStore(), "Right", PASSWORD);
    await ok.connect();
    expect(ok.types()).toEqual(["pinned", "authenticated"]);
    expect((await w.unit.status()).lock).toEqual({ failures: 0, until: 0 });
  }, 60_000);

  test("the lock doubles up to fifteen minutes and /connect unlock clears it", async () => {
    const w = await enabledWorld();
    for (let i = 0; i < 6; i++) {
      w.clock.now += 20 * 60_000;
      const bad = new Browser(w.links[0]!, `b${i}`, new MemoryStore(), "Bad", "wrong");
      await bad.connect();
    }
    const status = await w.unit.status();
    expect(status.lock.failures).toBe(6);
    expect(status.lock.until - w.clock.now).toBe(120_000);

    await w.unit.unlock();
    expect((await w.unit.status()).lock).toEqual({ failures: 0, until: 0 });
  }, 60_000);
});
