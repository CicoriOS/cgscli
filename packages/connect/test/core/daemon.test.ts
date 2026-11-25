import { expect, test } from "bun:test";
import { startDaemon, type TspCodec } from "../../src/index.ts";

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
function client(url: string) {
  const ws = new WebSocket(url);
  const msgs: M[] = [];
  let wake: (() => void)[] = [];
  ws.onmessage = (e) => { msgs.push(JSON.parse(String(e.data))); const w = wake; wake = []; w.forEach((f) => f()); };
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  // Resolves on the next message that makes `p` true; a hang is caught by the test timeout.
  const until = async (p: (m: M[]) => boolean) => {
    while (!p(msgs)) { const n = Promise.withResolvers<void>(); wake.push(n.resolve); await n.promise; }
  };
  const hello = (kind: string) => ws.send(JSON.stringify({ t: "hello", proto: [1, 1], client: { kind, version: "0" }, profile: { name: "t", renders: [] } }));
  return { msgs, until, opened: opened.promise, hello, send: (m: object) => ws.send(JSON.stringify(m)) };
}

const profile = { agentDir: "/tmp/cgs-test/agent", ompBin: "/usr/bin/true", baseEnv: { PATH: "/usr/bin" } };

test("daemon: snapshot, resume window, single writer, event reaches pty", async () => {
  const d = startDaemon({ transport: { kind: "loopback" }, connectVersion: "0.0.0", profile, codec, cmd: [process.execPath, "-e", fake] });
  try {
    const a = client(d.address);
    await a.opened;
    a.hello("cli");
    a.send({ t: "session.create" });
    await a.until((m) => m.some((x) => x.t === "session.created"));
    const id = a.msgs.find((x) => x.t === "session.created")!.id as string;
    a.send({ t: "session.open", id });
    await a.until((m) => m.some((x) => (x.t === "tsp.delta" || x.t === "tsp.snapshot") && x.seq === 2));

    const b = client(d.address);
    await b.opened;
    b.hello("web");
    b.send({ t: "session.open", id, resume: [{ streamId: "chat", lastSeq: 1 }] });
    await b.until((m) => m.some((x) => x.t === "tsp.delta"));
    expect(b.msgs.filter((x) => x.t === "tsp.delta").map((x) => x.seq)).toEqual([2]);
    expect(b.msgs.some((x) => x.t === "tsp.snapshot")).toBe(false);

    const c = client(d.address);
    await c.opened;
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
  const d = startDaemon({ transport: { kind: "loopback" }, connectVersion: "0", profile, codec, cmd: ["true"] });
  try {
    const c = client(d.address);
    await c.opened;
    c.send({ t: "hello", proto: [7, 9], client: { kind: "cli", version: "0" }, profile: { name: "t", renders: [] } });
    await c.until((m) => m.length > 0);
    expect(c.msgs[0]).toMatchObject({ t: "error", code: "proto-unsupported" });
  } finally { d.stop(); }
});
