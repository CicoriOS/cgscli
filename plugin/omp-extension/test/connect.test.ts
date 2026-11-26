import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createConnect, inheritedArgs, remoteStateFile, type UnitPort, type UnitStatus } from "../connect.ts";
import { writeAccount } from "../account.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function agentDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "connect-"));
  dirs.push(d);
  writeAccount(d, { baseUrl: "https://cgs.example", clientSecret: "secret", models: [], pricing: {}, capabilities: {} });
  return d;
}

function status(over: Partial<UnitStatus> = {}): UnitStatus {
  return { enabled: false, hasPassword: false, online: false, refused: null, sessions: { authenticated: 0 }, lock: { failures: 0, until: 0 }, browsers: [], fingerprint: { emoji: ["🦊", "🌲"] }, ...over };
}

/** A unit that records calls and answers from a small state machine like the real one. */
function fakeUnit(initial: UnitStatus, allowed = true) {
  const calls: { method: string; params: unknown }[] = [];
  let s = initial;
  const port: UnitPort = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "entitlement": return { allowed, enabled: s.enabled } as T;
        case "setPassword": s = { ...s, hasPassword: true }; return s as T;
        case "enable": s = { ...s, enabled: true }; return s as T;
        case "disable": s = { ...s, enabled: false }; return { ...s, serverNotified: true } as T;
        default: return s as T;
      }
    },
  };
  return { port, calls, methods: () => calls.map((c) => c.method) };
}

function ui(inputs: (string | undefined)[]) {
  const notes: string[] = [];
  const asked: { title: string; secret?: boolean }[] = [];
  return {
    notes, asked,
    ctx: {
      ui: {
        notify: (m: string) => void notes.push(m),
        input: async (title: string, _p?: string, o?: { secret?: boolean }) => { asked.push({ title, secret: o?.secret }); return inputs.shift(); },
        confirm: async () => true,
      },
    },
  };
}

test("the first /connect checks the entitlement, asks the password twice masked, then switches on", async () => {
  const dir = agentDir();
  const unit = fakeUnit(status());
  const c = createConnect({ agentDir: dir, openUnit: async () => unit.port, env: {}, argv: ["cgs", "-e", "/x/index.ts"], execPath: "/bin/cgs", deviceName: "Laptop" });
  const u = ui(["correct horse", "correct horse"]);
  await c.run("", u.ctx);
  expect(unit.methods()).toEqual(["configure", "status", "entitlement", "setPassword", "enable"]);
  expect(u.asked.every((a) => a.secret === true)).toBe(true);
  expect(unit.calls[3]!.params).toEqual({ password: "correct horse" });
  expect(unit.calls[0]!.params).toMatchObject({ baseUrl: "https://cgs.example", clientSecret: "secret", deviceName: "Laptop", command: ["/bin/cgs", "--mode", "rpc-ui", "-e", "/x/index.ts"] });
  expect(u.notes.at(-1)).toContain("🦊 🌲");
});

test("an account without the entitlement gets a refusal and no password prompt", async () => {
  const unit = fakeUnit(status(), false);
  const c = createConnect({ agentDir: agentDir(), openUnit: async () => unit.port, env: {} });
  const u = ui([]);
  await c.run("", u.ctx);
  expect(u.asked).toEqual([]);
  expect(u.notes.at(-1)).toContain("not allowed");
  expect(unit.methods()).not.toContain("enable");
});

test("a mismatched or short password changes nothing", async () => {
  const unit = fakeUnit(status());
  const c = createConnect({ agentDir: agentDir(), openUnit: async () => unit.port, env: {} });
  const u = ui(["longenough1", "longenough2"]);
  await c.run("", u.ctx);
  expect(u.notes.at(-1)).toContain("differ");
  const short = ui(["short"]);
  await c.run("", short.ctx);
  expect(short.notes.at(-1)).toContain("at least");
  expect(unit.methods()).not.toContain("setPassword");
});

test("once set up, bare /connect only reports and /connect off keeps the password", async () => {
  const unit = fakeUnit(status({ enabled: true, hasPassword: true, online: true }));
  const c = createConnect({ agentDir: agentDir(), openUnit: async () => unit.port, env: {} });
  const u = ui([]);
  await c.run("", u.ctx);
  expect(u.notes.at(-1)).toContain("online");
  await c.run("off", u.ctx);
  expect(unit.methods()).toContain("disable");
  expect(unit.methods()).not.toContain("forget");
  expect(u.notes.at(-1)).toContain("kept");
});

test("a daemon error becomes a plain message", async () => {
  const c = createConnect({ agentDir: agentDir(), openUnit: async () => { throw new Error("daemon unreachable"); }, env: {} });
  const u = ui([]);
  await c.run("status", u.ctx);
  expect(u.notes).toEqual(["daemon unreachable"]);
});

test("without a login there is nothing to configure", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "connect-"));
  dirs.push(d);
  let opened = false;
  const c = createConnect({ agentDir: d, openUnit: async () => { opened = true; return fakeUnit(status()).port; }, env: {} });
  const u = ui([]);
  await c.run("", u.ctx);
  expect(opened).toBe(false);
  expect(u.notes[0]).toContain("/login");
});

test("resume starts the unit only when the device switch was left on", async () => {
  const dir = agentDir();
  let opened = 0;
  const unit = fakeUnit(status());
  const c = createConnect({ agentDir: dir, openUnit: async () => { opened++; return unit.port; }, env: {} });
  await c.resume();
  expect(opened).toBe(0);
  fs.mkdirSync(path.dirname(remoteStateFile(dir)), { recursive: true });
  fs.writeFileSync(remoteStateFile(dir), JSON.stringify({ enabled: true }));
  await c.resume();
  await c.resume();
  expect(opened).toBe(1);
  expect(unit.methods()).toEqual(["configure", "configure"]);
});

test("sessions inherit the extension and overlay flags of this process", () => {
  expect(inheritedArgs(["cgs", "--config", "/o.yml", "-e", "/x/index.ts", "--model", "m", "hello"])).toEqual(["--config", "/o.yml", "-e", "/x/index.ts"]);
});
