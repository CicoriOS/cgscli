import { expect, test } from "bun:test";
import { ApcDecoder, encodeApc, ReplayBuffer, memoryPair } from "../src/index.ts";

const cat = (...a: Uint8Array[]) => Uint8Array.from(a.flatMap((x) => [...x]));
const txt = (s: string) => new TextEncoder().encode(s);

test("APC frames reassemble across every byte split, with passthrough", () => {
  const stream = cat(txt("ab"), encodeApc("hello"), txt("cd"), encodeApc("x\u4e2d"), txt("\x1b[0m"));
  for (let cut = 1; cut < stream.length; cut++) {
    const d = new ApcDecoder();
    const r1 = d.feed(stream.slice(0, cut)), r2 = d.feed(stream.slice(cut));
    expect([...r1.frames, ...r2.frames].map((f) => f.body)).toEqual(["hello", "x\u4e2d"]);
    expect(new TextDecoder().decode(cat(r1.passthrough, r2.passthrough))).toBe("abcd\x1b[0m");
  }
});

test("oversized APC body is rejected both ways", () => {
  expect(() => encodeApc("x".repeat(70000))).toThrow();
  const d = new ApcDecoder(16);
  expect(() => d.feed(cat(txt("\x1b_tsp;"), txt("y".repeat(40))))).toThrow();
});

test("ReplayBuffer: deltas in window, null after eviction", () => {
  const b = new ReplayBuffer<string>(3);
  for (const s of "abcde") b.push(s);
  expect(b.since(5)).toEqual([]);
  expect(b.since(3)!.map((i) => i.v)).toEqual(["d", "e"]);
  expect(b.since(2)!.length).toBe(3);
  expect(b.since(1)).toBeNull();
  expect(b.since(99)).toBeNull();
});

test("memoryPair delivers and closes both ends", async () => {
  const [a, b] = memoryPair();
  const got: unknown[] = [];
  b.onMessage((m) => got.push(m));
  let closed = 0;
  a.onClose(() => closed++);
  b.onClose(() => closed++);
  a.send({ t: "system.x", n: 1 });
  a.close();
  await Promise.resolve(); await Promise.resolve();
  expect(got).toEqual([{ t: "system.x", n: 1 }]);
  expect(closed).toBe(2);
});
