import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex, Msg } from "@cgscli/wire";
import { startDaemon, type TspCodec } from "../../src/index.ts";
import { defaultEndpoint, dial } from "../../src/transport.ts";

const codec: TspCodec = {
  parse: (b) => { try { return JSON.parse(b); } catch { return null; } },
  helloReply: () => JSON.stringify({ a: "hello", v: 1 }),
  ack: (f) => (f.q === "ops" ? JSON.stringify({ a: "ack", n: f.n }) : null),
  apply: (doc, f) => [...((doc as unknown[]) ?? []), f.op],
  surface: (f) => (typeof f.sf === "string" ? f.sf : null),
};

// Fake omp: DA1 query, hello, two op frames; echoes stdin so tests can observe what reached the pty.
const fake = `
const w = (s) => process.stdout.write(s);
w("\\x1b[c");
w("\\x1b_tsp;" + JSON.stringify({ q: "hello", v: [1] }) + "\\x1b\\\\");
for (let i = 1; i <= 2; i++) w("\\x1b_tsp;" + JSON.stringify({ q: "ops", sf: "chat", n: i, op: "o" + i }) + "\\x1b\\\\");
process.stdin.setRawMode(true);
process.stdin.on("data", (d) => w("GOT:" + d.toString().replace(/\\x1b/g, "^")));
setInterval(() => {}, 1000);
`;

type M = Record<string, unknown>;
const tmpEndpoint = () => process.platform === "win32"
  ? `\\\\.\\pipe\\cgsc-${crypto.randomUUID()}`
  : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cgsc-")), "c.sock");

async function client(endpoint: string) {
  const ch: Duplex = await dial(endpoint);
  const msgs: M[] = [];
  let wake: (() => void)[] = [];
  ch.onMessage((m: Msg) => { msgs.push(m); const w = wake; wake = []; w.forEach((f) => f()); });
  // Resolves on the next message that makes `p` true; a hang is caught by the test timeout.
  const until = async (p: (m: M[]) => boolean) => {
    while (!p(msgs)) { const n = Promise.withResolvers<void>(); wake.push(n.resolve); await n.promise; }
  };
  const hello = (kind: string) => ch.send({ t: "hello", proto: [1, 1], client: { kind, version: "0" }, profile: { name: "t", renders: [] } });
  return { msgs, until, hello, send: (m: object) => ch.send(m as Msg), close: () => ch.close() };
}

const profile = { agentDir: "/tmp/cgs-test/agent", ompBin: "/usr/bin/true", baseEnv: { PATH: "/usr/bin" } };

test("daemon: snapshot, resume window, single writer, event reaches pty", async () => {
  const d = await startDaemon({ endpoint: tmpEndpoint(), connectVersion: "0.0.0", profile, codec, cmd: [process.execPath, "-e", fake] });
  try {
    const a = await client(d.address);
    a.hello("cli");
    a.send({ t: "session.create" });
    await a.until((m) => m.some((x) => x.t === "session.created"));
    const id = a.msgs.find((x) => x.t === "session.created")!.id as string;
    a.send({ t: "session.open", id });
    await a.until((m) => m.some((x) => (x.t === "tsp.delta" || x.t === "tsp.snapshot") && x.seq === 2));

    const b = await client(d.address);
    b.hello("web");
    b.send({ t: "session.open", id, resume: [{ streamId: "chat", lastSeq: 1 }] });
    await b.until((m) => m.some((x) => x.t === "tsp.delta"));
    expect(b.msgs.filter((x) => x.t === "tsp.delta").map((x) => x.seq)).toEqual([2]);
    expect(b.msgs.some((x) => x.t === "tsp.snapshot")).toBe(false);

    const c = await client(d.address);
    c.hello("web");
    c.send({ t: "session.open", id });
    await c.until((m) => m.some((x) => x.t === "tsp.snapshot"));
    expect(c.msgs.find((x) => x.t === "tsp.snapshot")).toMatchObject({ seq: 2, doc: { chat: ["o1", "o2"] } });

    a.send({ t: "event.send", session: id, surface: "chat", id: "n1", text: "hi" });
    await a.until((m) => m.some((x) => x.t === "tsp.raw" && Buffer.from(String(x.data), "base64").toString().includes("GOT:")));
    b.send({ t: "event.send", session: id, surface: "chat", id: "n2", text: "yo" });
    await b.until((m) => m.some((x) => x.t === "error" && x.code === "not-writer"));
  } finally { d.stop(); }
});

test("protocol version mismatch is rejected", async () => {
  const d = await startDaemon({ endpoint: tmpEndpoint(), connectVersion: "0", profile, codec, cmd: ["true"] });
  try {
    const c = await client(d.address);
    c.send({ t: "hello", proto: [7, 9], client: { kind: "cli", version: "0" }, profile: { name: "t", renders: [] } });
    await c.until((m) => m.length > 0);
    expect(c.msgs[0]).toMatchObject({ t: "error", code: "proto-unsupported" });
  } finally { d.stop(); }
});

test("a second daemon refuses a live endpoint, and takes over a stale one", async () => {
  const ep = tmpEndpoint();
  const d = await startDaemon({ endpoint: ep, connectVersion: "0", profile, codec, cmd: ["true"] });
  await expect(startDaemon({ endpoint: ep, connectVersion: "0", profile, codec, cmd: ["true"] })).rejects.toThrow("already running");
  const c = await client(ep);
  c.close();
  d.stop();
  if (process.platform === "win32") return; // a pipe leaves no file behind
  // A crash leaves the socket file behind: a plain file where nobody listens must not block a restart.
  fs.writeFileSync(ep, "");
  const d2 = await startDaemon({ endpoint: ep, connectVersion: "0", profile, codec, cmd: ["true"] });
  d2.stop();
});

test("the socket is private to the user", async () => {
  const ep = tmpEndpoint();
  const d = await startDaemon({ endpoint: ep, connectVersion: "0", profile, codec, cmd: ["true"] });
  try {
    if (process.platform !== "win32") expect(fs.statSync(ep).mode & 0o777).toBe(0o600);
  } finally { d.stop(); }
  expect(fs.existsSync(ep)).toBe(false);
  expect(defaultEndpoint({ CGSCONNECT_SOCKET: "/x/y.sock" })).toBe("/x/y.sock");
});
