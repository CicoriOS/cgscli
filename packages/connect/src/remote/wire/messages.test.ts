import { describe, expect, test } from "bun:test";
import { encodeMessage, FrameDecoder, WIRE_LIMITS, WireError, type WireMessage } from "./messages.ts";

const FIRST = 0x01;
const LAST = 0x02;
const DEFLATE = 0x04;
const MAX_DATA = WIRE_LIMITS.recordPlaintext - 6;
const BIG = 100_000;
const HEAD = new Uint8Array(MAX_DATA);
const TAIL = new Uint8Array(BIG - MAX_DATA);
const enc = new TextEncoder();

const SAMPLES: WireMessage[] = [
  { k: "hello", proto: 1 },
  { k: "busy", by: "laptop" },
  { k: "taken_over", by: "phone" },
  { k: "takeover" },
  { k: "error", code: "bad_request" },
  { k: "req", id: "1", method: "GET", path: "/api/x" },
  { k: "req", id: "2", method: "POST", path: "/api/y", body: { a: [1, "two", null, true, { nested: 1.5 }] } },
  { k: "res", id: "2", status: 201, body: { ok: true } },
  { k: "res", id: "3", status: 204, body: null },
  { k: "open", cid: "c1", path: "/term" },
  { k: "frame", cid: "c1", text: "héllo 🌍" },
  { k: "close", cid: "c1" },
  { k: "close", cid: "c1", reason: "done" },
];

/** Builds one raw record, bypassing the encoder, to exercise the decoder's checks. */
function rec(flags: number, total: number, data: Uint8Array, version = 1): Uint8Array {
  const out = new Uint8Array(6 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, version);
  view.setUint8(1, flags);
  view.setUint32(2, total);
  out.set(data, 6);
  return out;
}

function jsonRecords(text: string): Uint8Array[] {
  const body = enc.encode(text);
  return [rec(FIRST | LAST, body.byteLength, body)];
}

/** Splits a body into records the way the encoder does, with the given DEFLATE flag. */
function splitBody(body: Uint8Array, deflate: boolean): Uint8Array[] {
  const records: Uint8Array[] = [];
  for (let off = 0; off < body.byteLength; off += MAX_DATA) {
    const end = Math.min(off + MAX_DATA, body.byteLength);
    const flags = (off === 0 ? FIRST | (deflate ? DEFLATE : 0) : 0) | (end === body.byteLength ? LAST : 0);
    records.push(rec(flags, body.byteLength, body.subarray(off, end)));
  }
  return records;
}

async function decodeAll(records: Uint8Array[]): Promise<WireMessage | null> {
  const decoder = new FrameDecoder();
  let result: WireMessage | null = null;
  for (const record of records) result = await decoder.push(record);
  return result;
}

async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const written = writer.write(input).then(() => writer.close());
  const [out] = await Promise.all([new Response(stream.readable).arrayBuffer(), written]);
  return new Uint8Array(out);
}

const flagsOf = (record: Uint8Array): number => record[1]!;
const totalOf = (record: Uint8Array): number => new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(2);

function nestedArrays(depth: number): unknown {
  let value: unknown = [];
  for (let i = 1; i < depth; i++) value = [value];
  return value;
}

describe("round trip", () => {
  SAMPLES.forEach((message, i) => {
    for (const compress of [true, false]) {
      test(`sample ${i} (${message.k}) round-trips with compress=${compress}`, async () => {
        expect(await decodeAll(await encodeMessage(message, { compress }))).toEqual(message);
      });
    }
  });

  test("decodes consecutive messages on one connection", async () => {
    const decoder = new FrameDecoder();
    for (const message of SAMPLES) {
      let result: WireMessage | null = null;
      for (const record of await encodeMessage(message)) result = await decoder.push(record);
      expect(result).toEqual(message);
    }
  });

  test("concurrent pushes are processed in call order", async () => {
    const message: WireMessage = { k: "frame", cid: "c", text: "b".repeat(300_000) };
    const records = await encodeMessage(message, { compress: false });
    expect(records.length).toBeGreaterThan(1);
    const decoder = new FrameDecoder();
    const results = await Promise.all(records.map((record) => decoder.push(record)));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results[results.length - 1]).toEqual(message);
  });

  test("accepts nesting of exactly 64 levels and rejects 65", async () => {
    const ok: WireMessage = { k: "res", id: "1", status: 200, body: nestedArrays(64) };
    expect(await decodeAll(await encodeMessage(ok))).toEqual(ok);
    const tooDeep = { k: "res", id: "1", status: 200, body: nestedArrays(65) } as WireMessage;
    await expect(encodeMessage(tooDeep)).rejects.toThrow("JSON nested too deeply");
  });
});

describe("compression", () => {
  test("compresses large compressible bodies", async () => {
    const message: WireMessage = { k: "frame", cid: "c", text: "abc ".repeat(50_000) };
    const records = await encodeMessage(message);
    expect(flagsOf(records[0]!) & DEFLATE).toBe(DEFLATE);
    expect(totalOf(records[0]!)).toBeLessThan(enc.encode(JSON.stringify(message)).byteLength);
    expect(await decodeAll(records)).toEqual(message);
  });

  test("does not compress bodies of 1 KiB or less", async () => {
    const message: WireMessage = { k: "frame", cid: "c", text: "abc ".repeat(100) };
    expect(enc.encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(WIRE_LIMITS.compressAboveBytes);
    const records = await encodeMessage(message);
    expect(flagsOf(records[0]!) & DEFLATE).toBe(0);
  });

  test("compress:false sends the JSON bytes with no DEFLATE flag", async () => {
    const message: WireMessage = { k: "frame", cid: "c", text: "abc ".repeat(50_000) };
    const records = await encodeMessage(message, { compress: false });
    for (const record of records) expect(flagsOf(record) & DEFLATE).toBe(0);
    expect(totalOf(records[0]!)).toBe(enc.encode(JSON.stringify(message)).byteLength);
    expect(await decodeAll(records)).toEqual(message);
  });

  test("falls back to raw when CompressionStream is unavailable, and refuses deflated input", async () => {
    const message: WireMessage = { k: "frame", cid: "c", text: "a".repeat(10_000) };
    const deflated = await encodeMessage(message);
    expect(flagsOf(deflated[0]!) & DEFLATE).toBe(DEFLATE);
    const savedCompression = globalThis.CompressionStream;
    const savedDecompression = globalThis.DecompressionStream;
    Reflect.deleteProperty(globalThis, "CompressionStream");
    Reflect.deleteProperty(globalThis, "DecompressionStream");
    try {
      const raw = await encodeMessage(message);
      expect(flagsOf(raw[0]!) & DEFLATE).toBe(0);
      expect(await decodeAll(raw)).toEqual(message);
      await expect(decodeAll(deflated)).rejects.toThrow("deflate-raw is not supported");
    } finally {
      globalThis.CompressionStream = savedCompression;
      globalThis.DecompressionStream = savedDecompression;
    }
  });
});

describe("record framing", () => {
  test("large bodies split into full records, each within the record limit", async () => {
    const message: WireMessage = { k: "frame", cid: "c", text: "x".repeat(200_000) };
    const len = enc.encode(JSON.stringify(message)).byteLength;
    const records = await encodeMessage(message, { compress: false });
    expect(records.length).toBe(Math.ceil(len / MAX_DATA));
    records.forEach((record, i) => {
      const last = i === records.length - 1;
      expect(record.byteLength).toBeLessThanOrEqual(WIRE_LIMITS.recordPlaintext);
      if (!last) expect(record.byteLength).toBe(WIRE_LIMITS.recordPlaintext);
      expect(flagsOf(record) & FIRST).toBe(i === 0 ? FIRST : 0);
      expect(flagsOf(record) & LAST).toBe(last ? LAST : 0);
      expect(totalOf(record)).toBe(len);
    });
    expect(await decodeAll(records)).toEqual(message);
  });

  test("a compressed message whose deflated body spans several records stays within the record limit", async () => {
    const random = new Uint8Array(300_000);
    crypto.getRandomValues(random);
    const text = Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
    const message: WireMessage = { k: "frame", cid: "c", text };
    const records = await encodeMessage(message);
    expect(flagsOf(records[0]!) & DEFLATE).toBe(DEFLATE);
    expect(records.length).toBeGreaterThan(1);
    for (const record of records) expect(record.byteLength).toBeLessThanOrEqual(WIRE_LIMITS.recordPlaintext);
    expect(await decodeAll(records)).toEqual(message);
  });
});

describe("encoder validation", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const invalid: [string, unknown, string][] = [
    ["null message", null, "message must be a JSON object"],
    ["array message", [], "message must be a JSON object"],
    ["unknown kind", { k: "nope" }, "unknown message kind"],
    ["hello with proto 2", { k: "hello", proto: 2 }, "hello.proto must be 1"],
    ["extra field", { k: "takeover", extra: 1 }, 'unexpected field "extra"'],
    ["missing field", { k: "req", id: "1", method: "GET" }, 'missing field "path"'],
    ["non-string id", { k: "res", id: 1, status: 200, body: null }, 'field "id" must be a string'],
    ["status 99", { k: "res", id: "1", status: 99, body: null }, "res.status must be"],
    ["status 1000", { k: "res", id: "1", status: 1000, body: null }, "res.status must be"],
    ["fractional status", { k: "res", id: "1", status: 200.5, body: null }, "res.status must be"],
    ["undefined body", { k: "res", id: "1", status: 200, body: undefined }, "undefined is not JSON"],
    ["NaN body", { k: "res", id: "1", status: 200, body: NaN }, "non-finite number"],
    ["Infinity in array", { k: "res", id: "1", status: 200, body: [Infinity] }, "non-finite number"],
    ["function body", { k: "res", id: "1", status: 200, body: () => 1 }, "function is not JSON"],
    ["bigint body", { k: "res", id: "1", status: 200, body: 1n }, "bigint is not JSON"],
    ["symbol body", { k: "res", id: "1", status: 200, body: Symbol("x") }, "symbol is not JSON"],
    ["Date body", { k: "res", id: "1", status: 200, body: new Date(0) }, "object is not JSON"],
    ["Map body", { k: "res", id: "1", status: 200, body: new Map() }, "object is not JSON"],
    ["undefined in array", { k: "res", id: "1", status: 200, body: [1, undefined] }, "undefined is not JSON"],
    ["cyclic body", { k: "res", id: "1", status: 200, body: cyclic }, "JSON nested too deeply"],
  ];
  for (const [name, message, reason] of invalid) {
    test(`rejects ${name}`, async () => {
      await expect(encodeMessage(message as WireMessage)).rejects.toThrow(reason);
    });
  }

  test("rejects encoding failures with WireError", async () => {
    await expect(encodeMessage({ k: "takeover", extra: 1 } as WireMessage)).rejects.toBeInstanceOf(WireError);
  });

  test("16 MiB of JSON is accepted, one byte more is rejected", async () => {
    const base = JSON.stringify({ k: "frame", cid: "c", text: "" }).length;
    const exact: WireMessage = { k: "frame", cid: "c", text: "a".repeat(WIRE_LIMITS.messageBytes - base) };
    expect(enc.encode(JSON.stringify(exact)).byteLength).toBe(WIRE_LIMITS.messageBytes);
    expect(await decodeAll(await encodeMessage(exact))).toEqual(exact);

    const over = { k: "frame", cid: "c", text: "a".repeat(WIRE_LIMITS.messageBytes - base + 1) } as WireMessage;
    await expect(encodeMessage(over)).rejects.toThrow("message exceeds 16 MiB");
    await expect(encodeMessage(over, { compress: false })).rejects.toThrow("message exceeds 16 MiB");
  });
});

describe("decoder: malformed JSON bodies", () => {
  const invalid: [string, string, string][] = [
    ["not JSON", "{", "not strict UTF-8 JSON"],
    ["NaN literal", '{"k":"res","id":"1","status":200,"body":NaN}', "not strict UTF-8 JSON"],
    ["array", "[1]", "message must be a JSON object"],
    ["null", "null", "message must be a JSON object"],
    ["number", "7", "message must be a JSON object"],
    ["missing kind", '{"cid":"c"}', "unknown message kind"],
    ["unknown kind", '{"k":"nope"}', "unknown message kind"],
    ["hello proto 2", '{"k":"hello","proto":2}', "hello.proto must be 1"],
    ["hello proto string", '{"k":"hello","proto":"1"}', "hello.proto must be 1"],
    ["extra field", '{"k":"takeover","extra":1}', 'unexpected field "extra"'],
    ["missing body", '{"k":"res","id":"1","status":200}', 'missing field "body"'],
    ["status 0", '{"k":"res","id":"1","status":0,"body":null}', "res.status must be"],
    ["number cid", '{"k":"open","cid":5,"path":"/"}', 'field "cid" must be a string'],
    ["number reason", '{"k":"close","cid":"c","reason":5}', 'field "reason" must be a string'],
    ["frame missing text", '{"k":"frame","cid":"c"}', 'missing field "text"'],
    ["infinite number", '{"k":"res","id":"1","status":200,"body":1e999}', "non-finite number"],
    ["deep body", '{"k":"req","id":"1","method":"GET","path":"/","body":' + "[".repeat(65) + "]".repeat(65) + "}", "JSON nested too deeply"],
  ];
  for (const [name, text, reason] of invalid) {
    test(`rejects ${name}`, async () => {
      await expect(decodeAll(jsonRecords(text))).rejects.toThrow(reason);
    });
  }

  test("rejects invalid UTF-8", async () => {
    await expect(decodeAll([rec(FIRST | LAST, 1, Uint8Array.of(0xff))])).rejects.toThrow("not strict UTF-8 JSON");
  });
});

describe("decoder: malformed framing", () => {
  const cases: [string, () => Uint8Array[], string][] = [
    ["wire version 2", () => [rec(FIRST | LAST, 2, enc.encode("{}"), 2)], "unsupported wire version"],
    ["reserved flag bit", () => [rec(FIRST | LAST | 0x08, 2, enc.encode("{}"))], "reserved record flags"],
    ["zero body length", () => [rec(FIRST | LAST, 0, enc.encode("{}"))], "body length out of range"],
    ["declared length over 16 MiB", () => [rec(FIRST, WIRE_LIMITS.messageBytes + 1, HEAD)], "body length out of range"],
    ["header without body", () => [rec(FIRST | LAST, 1, new Uint8Array(0))], "record has no body"],
    ["record over the record limit", () => [rec(FIRST | LAST, 10, new Uint8Array(WIRE_LIMITS.recordPlaintext + 1))], "record exceeds the record limit"],
    ["continuation without first", () => [rec(LAST, 2, enc.encode("{}"))], "continuation record without a first record"],
    ["new message before previous completed", () => [rec(FIRST, BIG, HEAD), rec(FIRST | LAST, 2, enc.encode("{}"))], "new message started before"],
    ["DEFLATE on continuation", () => [rec(FIRST, BIG, HEAD), rec(LAST | DEFLATE, BIG, TAIL)], "DEFLATE flag on a continuation"],
    ["length changes mid-message", () => [rec(FIRST, BIG, HEAD), rec(LAST, BIG + 1, TAIL)], "body length changed mid-message"],
    ["short non-final record", () => [rec(FIRST, BIG, new Uint8Array(1000))], "non-final record is not full"],
    ["record overruns declared length", () => [rec(FIRST | LAST, 5, enc.encode("123456789"))], "overruns declared body length"],
    ["LAST missing on final record", () => [rec(FIRST, 2, enc.encode("{}"))], "LAST flag does not match"],
    ["LAST set on non-final record", () => [rec(FIRST | LAST, BIG, HEAD)], "LAST flag does not match"],
    ["corrupt deflate stream", () => [rec(FIRST | LAST | DEFLATE, 4, Uint8Array.of(0xff, 0xff, 0xff, 0xff))], "corrupt deflate body"],
  ];
  for (const [name, build, reason] of cases) {
    test(`rejects ${name}`, async () => {
      await expect(decodeAll(build())).rejects.toThrow(reason);
    });
  }

  test("fails closed: after an error every later record is rejected", async () => {
    const decoder = new FrameDecoder();
    await expect(decoder.push(rec(LAST, 2, enc.encode("{}")))).rejects.toThrow("continuation record");
    const valid = await encodeMessage({ k: "takeover" }, { compress: false });
    await expect(decoder.push(valid[0]!)).rejects.toThrow("decoder already failed");
  });

  test("a length change mid-message fails the whole connection, not just that message", async () => {
    const decoder = new FrameDecoder();
    expect(await decoder.push(rec(FIRST, BIG, HEAD))).toBeNull();
    await expect(decoder.push(rec(LAST, BIG + 1, TAIL))).rejects.toThrow("body length changed");
    await expect(decoder.push(rec(LAST, BIG, TAIL))).rejects.toThrow("decoder already failed");
  });
});

describe("limits", () => {
  test("a deflate bomb is cut off once inflation passes 16 MiB", async () => {
    const bomb = await deflateRaw(new Uint8Array(WIRE_LIMITS.messageBytes + 1));
    expect(bomb.byteLength).toBeLessThan(WIRE_LIMITS.messageBytes);
    await expect(decodeAll(splitBody(bomb, true))).rejects.toThrow("inflated body exceeds 16 MiB");
  });

  test("a deflated body is subject to the JSON checks after inflation", async () => {
    const inner = enc.encode('{"k":"nope"}'.padEnd(2000, " "));
    await expect(decodeAll(splitBody(await deflateRaw(inner), true))).rejects.toThrow("unknown message kind");
  });
});
