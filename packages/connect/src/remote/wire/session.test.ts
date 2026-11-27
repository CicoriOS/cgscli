import { beforeAll, describe, expect, test } from "bun:test";
import {
  addBrowser,
  BrowserSession,
  createDeviceCredentials,
  createPasswordVerifier,
  DeviceSession,
  fromBase64,
  revokeBrowser,
  type BrowserStore,
  type DeviceCredentials,
  type PasswordVerifier,
  type SavedBrowser,
  type WireEvent,
  type WireMessage,
} from "./index.ts";

const PASSWORD = "correct horse battery staple";
let verifier: PasswordVerifier;
beforeAll(async () => {
  verifier = await createPasswordVerifier(PASSWORD);
});

class MemoryStore implements BrowserStore {
  saved: SavedBrowser | null = null;
  async load() {
    return this.saved;
  }
  async save(value: SavedBrowser) {
    this.saved = value;
  }
}

interface Link {
  creds: DeviceCredentials;
  device: DeviceSession;
  browser: BrowserSession;
  deviceEvents: WireEvent[];
  browserEvents: WireEvent[];
}

function link(creds: DeviceCredentials, store: BrowserStore, password: string | undefined, options: { allowed?: () => boolean } = {}): Link {
  const l: Link = {
    creds,
    device: new DeviceSession({ credentials: creds, passwordAllowed: options.allowed }),
    browser: new BrowserSession({ store, name: "Test browser", password }),
    deviceEvents: [],
    browserEvents: [],
  };
  return l;
}

/** Runs the handshake to completion, applying device events (persisting a registered browser) before forwarding. */
async function handshake(l: Link): Promise<void> {
  let toDevice = (await l.browser.start()).outgoing;
  for (let round = 0; round < 8 && toDevice.length > 0; round++) {
    const toBrowser: Uint8Array[] = [];
    for (const payload of toDevice) {
      const step = await l.device.receive(payload);
      for (const event of step.events) {
        l.deviceEvents.push(event);
        if (event.type === "registered") l.creds = addBrowser(l.creds, event.browser);
      }
      toBrowser.push(...step.outgoing);
    }
    toDevice = [];
    for (const payload of toBrowser) {
      const step = await l.browser.receive(payload);
      l.browserEvents.push(...step.events);
      toDevice.push(...step.outgoing);
    }
  }
}

const types = (events: WireEvent[]) => events.map((e) => e.type);

async function roundTrip(l: Link, from: "browser" | "device", message: WireMessage): Promise<WireMessage> {
  const sender = from === "browser" ? l.browser : l.device;
  const receiver = from === "browser" ? l.device : l.browser;
  let got: WireMessage | undefined;
  for (const payload of await sender.send(message)) {
    const step = await receiver.receive(payload);
    for (const e of step.events) if (e.type === "message") got = e.message;
  }
  if (!got) throw new Error("no message arrived");
  return got;
}

describe("first connection with the password", () => {
  test("both sides authenticate, the browser pins the device key, the device registers the browser", async () => {
    const creds = createDeviceCredentials(verifier);
    const store = new MemoryStore();
    const l = link(creds, store, PASSWORD);
    await handshake(l);

    expect(types(l.browserEvents)).toEqual(["pinned", "authenticated"]);
    expect(l.browserEvents[0]).toEqual({ type: "pinned", pin: creds.staticKey.publicKey });
    expect(types(l.deviceEvents)).toEqual(["registered", "authenticated"]);
    expect(l.deviceEvents[1]).toMatchObject({ via: "password", browser: { name: "Test browser" } });
    expect(store.saved?.pin).toBe(creds.staticKey.publicKey);
    expect(store.saved?.privateKey.extractable).toBe(false);
    expect(l.creds.browsers).toHaveLength(1);
  });

  test("application messages flow both ways, including one spanning several records", async () => {
    const l = link(createDeviceCredentials(verifier), new MemoryStore(), PASSWORD);
    await handshake(l);

    expect(await roundTrip(l, "browser", { k: "hello", proto: 1 })).toEqual({ k: "hello", proto: 1 });
    const big = "x".repeat(400_000) + Array.from({ length: 4000 }, (_, i) => String(i * 7919)).join("");
    const res = await roundTrip(l, "device", { k: "res", id: "1", status: 200, body: { big } });
    expect(res).toEqual({ k: "res", id: "1", status: 200, body: { big } });
    expect(await roundTrip(l, "browser", { k: "req", id: "2", method: "GET", path: "/api/info" })).toMatchObject({ k: "req", id: "2" });
  });

  test("a wrong password fails on both sides and saves nothing", async () => {
    const store = new MemoryStore();
    const l = link(createDeviceCredentials(verifier), store, "not the password");
    await handshake(l);

    expect(l.deviceEvents).toEqual([{ type: "auth_failed", via: "password", code: "bad_password" }]);
    expect(l.browserEvents).toEqual([{ type: "auth_failed", via: "password", code: "bad_password" }]);
    expect(store.saved).toBeNull();
    expect(l.creds.browsers).toHaveLength(0);
  });

  test("a locked device refuses without counting as a wrong password", async () => {
    const l = link(createDeviceCredentials(verifier), new MemoryStore(), PASSWORD, { allowed: () => false });
    await handshake(l);
    expect(l.deviceEvents).toEqual([{ type: "auth_failed", via: "password", code: "locked" }]);
    expect(l.browserEvents).toEqual([{ type: "auth_failed", via: "password", code: "locked" }]);
  });

  test("a device with no password set refuses password connections", async () => {
    const l = link(createDeviceCredentials(null), new MemoryStore(), PASSWORD);
    await handshake(l);
    expect(l.deviceEvents).toEqual([{ type: "auth_failed", via: "password", code: "no_password" }]);
  });

});

describe("first connection, fingerprint before the password", () => {
  /** Browser without a password: runs until it stops at `challenged`; returns the payloads the device answered. */
  async function toChallenge(l: Link): Promise<Uint8Array[]> {
    const [start] = (await l.browser.start()).outgoing;
    const reply = await l.device.receive(start!);
    const events: WireEvent[] = [];
    for (const payload of reply.outgoing) events.push(...(await l.browser.receive(payload)).events);
    l.browserEvents.push(...events);
    return reply.outgoing;
  }

  async function finish(l: Link, password: string): Promise<void> {
    let toDevice = (await l.browser.answer(password)).outgoing;
    for (let round = 0; round < 8 && toDevice.length > 0; round++) {
      const toBrowser: Uint8Array[] = [];
      for (const payload of toDevice) {
        const step = await l.device.receive(payload);
        for (const event of step.events) {
          l.deviceEvents.push(event);
          if (event.type === "registered") l.creds = addBrowser(l.creds, event.browser);
        }
        toBrowser.push(...step.outgoing);
      }
      toDevice = [];
      for (const payload of toBrowser) {
        const step = await l.browser.receive(payload);
        l.browserEvents.push(...step.events);
        toDevice.push(...step.outgoing);
      }
    }
  }

  test("the device key is shown before any password is used, then the password completes the handshake", async () => {
    const creds = createDeviceCredentials(verifier);
    const store = new MemoryStore();
    const l = link(creds, store, undefined);
    await toChallenge(l);

    expect(l.browserEvents).toEqual([{ type: "challenged", pin: creds.staticKey.publicKey }]);
    expect(store.saved).toBeNull();
    expect(l.deviceEvents).toEqual([]);

    await finish(l, PASSWORD);
    expect(types(l.browserEvents)).toEqual(["challenged", "pinned", "authenticated"]);
    expect(store.saved?.pin).toBe(creds.staticKey.publicKey);
    expect(await roundTrip(l, "browser", { k: "hello", proto: 1 })).toEqual({ k: "hello", proto: 1 });
  });

  test("a wrong password after the fingerprint fails like before and saves nothing", async () => {
    const store = new MemoryStore();
    const l = link(createDeviceCredentials(verifier), store, undefined);
    await toChallenge(l);
    await finish(l, "not the password");
    expect(l.browserEvents.at(-1)).toEqual({ type: "auth_failed", via: "password", code: "bad_password" });
    expect(store.saved).toBeNull();
  });

  test("a device that predates the announce flag still works: no key in the challenge, the browser asks for the password first", async () => {
    const creds = createDeviceCredentials(verifier);
    const store = new MemoryStore();
    const l = link(creds, store, undefined);
    await l.browser.start();
    const oldStart = await l.device.receive(Uint8Array.of(0x01)); // what a browser without the flag sends
    expect(oldStart.outgoing[0]).toHaveLength(1 + 16 + 16 + 65);
    l.browserEvents.push(...(await l.browser.receive(oldStart.outgoing[0]!)).events);
    expect(l.browserEvents).toEqual([{ type: "challenged" }]);

    await finish(l, PASSWORD);
    expect(types(l.browserEvents)).toEqual(["challenged", "pinned", "authenticated"]);
    expect(store.saved?.pin).toBe(creds.staticKey.publicKey);
  });

  test("a key announced in the challenge that the device then replaces is refused", async () => {
    const creds = createDeviceCredentials(verifier);
    const impostor = createDeviceCredentials(verifier);
    const l = link(creds, new MemoryStore(), undefined);
    const [start] = (await l.browser.start()).outgoing;
    const challenge = (await l.device.receive(start!)).outgoing[0]!.slice();
    challenge.set(fromBase64(impostor.staticKey.publicKey), challenge.length - 32); // someone on the path swaps the announced key
    l.browserEvents.push(...(await l.browser.receive(challenge)).events);
    expect(l.browserEvents).toEqual([{ type: "challenged", pin: impostor.staticKey.publicKey }]);
    await expect(finish(l, PASSWORD)).rejects.toThrow("announced");
  });

  test("answer needs a challenge", async () => {
    const l = link(createDeviceCredentials(verifier), new MemoryStore(), undefined);
    await expect(l.browser.answer(PASSWORD)).rejects.toThrow("challenge");
    await l.browser.start();
    await expect(l.browser.answer(PASSWORD)).rejects.toThrow("challenge");
  });

  test("a locked device refuses the announce request the same way", async () => {
    const l = link(createDeviceCredentials(verifier), new MemoryStore(), undefined, { allowed: () => false });
    await handshake(l);
    expect(l.browserEvents).toEqual([{ type: "auth_failed", via: "password", code: "locked" }]);
  });
});

describe("later connections with the saved key", () => {
  async function paired() {
    const creds = createDeviceCredentials(verifier);
    const store = new MemoryStore();
    const first = link(creds, store, PASSWORD);
    await handshake(first);
    return { creds: first.creds, store };
  }

  test("resume authenticates without a password", async () => {
    const { creds, store } = await paired();
    const l = link(creds, store, undefined);
    await handshake(l);

    expect(types(l.browserEvents)).toEqual(["authenticated"]);
    expect(l.browserEvents[0]).toMatchObject({ via: "key", browser: { name: "Test browser" } });
    expect(l.deviceEvents[0]).toMatchObject({ type: "authenticated", via: "key" });
    expect(await roundTrip(l, "device", { k: "busy", by: "Other" })).toEqual({ k: "busy", by: "Other" });
  });

  test("a revoked browser is denied", async () => {
    const { creds, store } = await paired();
    const l = link(revokeBrowser(creds, creds.browsers[0]!.id), store, undefined);
    await handshake(l);
    expect(l.deviceEvents).toEqual([{ type: "auth_failed", via: "key", code: "unknown_browser" }]);
    expect(l.browserEvents).toEqual([{ type: "auth_failed", via: "key", code: "unknown_browser" }]);
  });

  test("a signature from a different key is denied", async () => {
    const { creds, store } = await paired();
    const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const forged: BrowserStore = { load: async () => ({ ...store.saved!, privateKey: other.privateKey }), save: async () => {} };
    const l = link(creds, forged, undefined);
    await handshake(l);
    expect(l.deviceEvents).toEqual([{ type: "auth_failed", via: "key", code: "bad_signature" }]);
    expect(l.browserEvents).toEqual([{ type: "auth_failed", via: "key", code: "bad_signature" }]);
  });

  test("a different device behind the same pin is reported as a pin mismatch, not trusted", async () => {
    const { store } = await paired();
    const impostor = createDeviceCredentials(verifier);
    const l = link(impostor, store, undefined);
    await handshake(l);
    expect(l.browserEvents).toEqual([{ type: "pin_mismatch", expected: store.saved!.pin, received: impostor.staticKey.publicKey }]);
    expect(store.saved!.pin).not.toBe(impostor.staticKey.publicKey);
  });

  test("changing the password drops every authorized browser", async () => {
    const { creds, store } = await paired();
    const { changePassword } = await import("./index.ts");
    const l = link(changePassword(creds, verifier), store, undefined);
    await handshake(l);
    expect(l.browserEvents).toEqual([{ type: "auth_failed", via: "key", code: "unknown_browser" }]);
  });
});

describe("the channel", () => {
  test("a tampered payload is rejected and a replayed one too", async () => {
    const l = link(createDeviceCredentials(verifier), new MemoryStore(), PASSWORD);
    await handshake(l);
    const [payload] = await l.browser.send({ k: "hello", proto: 1 });
    const tampered = payload!.slice();
    tampered[tampered.length - 1]! ^= 1;
    await expect(l.device.receive(tampered)).rejects.toThrow();
  });

  test("the same payload cannot be delivered twice", async () => {
    const l = link(createDeviceCredentials(verifier), new MemoryStore(), PASSWORD);
    await handshake(l);
    const [payload] = await l.browser.send({ k: "hello", proto: 1 });
    await l.device.receive(payload!);
    await expect(l.device.receive(payload!)).rejects.toThrow();
  });

  test("handshake bytes after authentication are not application data", async () => {
    const l = link(createDeviceCredentials(verifier), new MemoryStore(), PASSWORD);
    await handshake(l);
    await expect(l.device.receive(Uint8Array.of(0x01))).rejects.toThrow();
  });

  test("a device key is 32 bytes on the wire", () => {
    expect(fromBase64(createDeviceCredentials(verifier).staticKey.publicKey)).toHaveLength(32);
  });
});
