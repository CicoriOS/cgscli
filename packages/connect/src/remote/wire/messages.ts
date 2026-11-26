// Connect wire v1 framing. Public contract: README.md in this directory.
//
// encodeMessage: WireMessage -> strict JSON -> optional raw deflate -> records.
// FrameDecoder:  records (one decrypted plaintext each, in order) -> validated WireMessage.
//
// Record (one encrypted-record plaintext, at most WIRE_LIMITS.recordPlaintext bytes):
//   byte 0     version, must be 1
//   byte 1     flags: FIRST 0x01, LAST 0x02, DEFLATE 0x04 (FIRST record only); other bits must be 0
//   bytes 2-5  body length in bytes, u32 big-endian, identical on every record of the message
//   bytes 6-   body slice
// Every record but the last carries exactly the maximum data size, so the record count is fixed by the
// body length and any other split is rejected.

export const WIRE_LIMITS = {
  /**
   * Largest record plaintext, header included. A Noise message is at most 65535 bytes and carries a 16-byte tag; the
   * session adds one kind byte, so a record is at most 65535 - 16 - 1.
   */
  recordPlaintext: 65518,
  /** Largest body: the JSON before compression, and the body on the wire after it. */
  messageBytes: 16 * 1024 * 1024,
  /** Bodies larger than this are offered to deflate. */
  compressAboveBytes: 1024,
} as const;

const WIRE_VERSION = 1;
const HEADER_BYTES = 6;
const MAX_RECORD_DATA = WIRE_LIMITS.recordPlaintext - HEADER_BYTES;
const FLAG_FIRST = 0x01;
const FLAG_LAST = 0x02;
const FLAG_DEFLATE = 0x04;
const KNOWN_FLAGS = FLAG_FIRST | FLAG_LAST | FLAG_DEFLATE;
const MAX_JSON_DEPTH = 64;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

/** The `close` reason for a stream that names no running child: reopening it cannot succeed. */
export const UNKNOWN_CHILD_REASON = "Unknown omp child";

export type WireMessage =
  | { k: "hello"; proto: 1 }
  | { k: "busy" | "taken_over"; by: string }
  | { k: "takeover" }
  | { k: "error"; code: string }
  | { k: "req"; id: string; method: string; path: string; body?: unknown }
  | { k: "res"; id: string; status: number; body: unknown }
  | { k: "open"; cid: string; path: string }
  | { k: "ready"; cid: string }
  | { k: "frame"; cid: string; text: string }
  | { k: "close"; cid: string; reason?: string };

export interface EncodeOptions {
  /** Deflate bodies over WIRE_LIMITS.compressAboveBytes when smaller. Default true. Pass false for secrets mixed with attacker-controlled text. */
  compress?: boolean;
}

/** Serializes a message into records, each to be sealed as one encrypted-record plaintext. */
export async function encodeMessage(message: WireMessage, options: EncodeOptions = {}): Promise<Uint8Array[]> {
  validateMessage(message);
  const raw = utf8Encoder.encode(JSON.stringify(message));
  if (raw.byteLength > WIRE_LIMITS.messageBytes) throw new WireError("message exceeds 16 MiB");
  let body = raw;
  let deflate = false;
  if (options.compress !== false && raw.byteLength > WIRE_LIMITS.compressAboveBytes) {
    const packed = await deflateRaw(raw);
    if (packed) {
      body = packed;
      deflate = true;
    }
  }
  return frameRecords(body, deflate);
}

interface Pending {
  total: number;
  deflate: boolean;
  parts: Uint8Array<ArrayBuffer>[];
  received: number;
}

/**
 * Reassembles records from one connection. Pushes are processed in call order, so records may be pushed without
 * awaiting each one. Any protocol error fails the decoder permanently: start a new connection.
 * The chunk passed to push must not be modified until its promise settles.
 */
export class FrameDecoder {
  private pending: Pending | null = null;
  private failed = false;
  private queue: Promise<unknown> = Promise.resolve();

  push(chunk: Uint8Array): Promise<WireMessage | null> {
    const result = this.queue.then(() => this.accept(chunk));
    this.queue = result.catch(() => {});
    return result;
  }

  private async accept(chunk: Uint8Array): Promise<WireMessage | null> {
    if (this.failed) throw new WireError("decoder already failed; start a new connection");
    try {
      return await this.consume(chunk);
    } catch (err) {
      this.failed = true;
      this.pending = null;
      throw err;
    }
  }

  private async consume(chunk: Uint8Array): Promise<WireMessage | null> {
    if (chunk.byteLength <= HEADER_BYTES) throw new WireError("record has no body");
    if (chunk.byteLength > WIRE_LIMITS.recordPlaintext) throw new WireError("record exceeds the record limit");
    const header = new DataView(chunk.buffer, chunk.byteOffset, HEADER_BYTES);
    if (header.getUint8(0) !== WIRE_VERSION) throw new WireError("unsupported wire version");
    const flags = header.getUint8(1);
    if ((flags & ~KNOWN_FLAGS) !== 0) throw new WireError("reserved record flags set");
    const total = header.getUint32(2);
    if (total < 1 || total > WIRE_LIMITS.messageBytes) throw new WireError("body length out of range");

    let pending = this.pending;
    if ((flags & FLAG_FIRST) !== 0) {
      if (pending) throw new WireError("new message started before the previous one completed");
      pending = { total, deflate: (flags & FLAG_DEFLATE) !== 0, parts: [], received: 0 };
      this.pending = pending;
    } else {
      if (!pending) throw new WireError("continuation record without a first record");
      if ((flags & FLAG_DEFLATE) !== 0) throw new WireError("DEFLATE flag on a continuation record");
      if (total !== pending.total) throw new WireError("body length changed mid-message");
    }

    const data = chunk.subarray(HEADER_BYTES);
    const remaining = pending.total - pending.received;
    if (data.byteLength > remaining) throw new WireError("record overruns declared body length");
    const final = data.byteLength === remaining;
    if (final !== ((flags & FLAG_LAST) !== 0)) throw new WireError("LAST flag does not match record position");
    if (!final && data.byteLength !== MAX_RECORD_DATA) throw new WireError("non-final record is not full");

    pending.parts.push(data.slice());
    pending.received += data.byteLength;
    if (!final) return null;

    this.pending = null;
    const body = concat(pending.parts, pending.total);
    return parseMessage(pending.deflate ? await inflateRaw(body) : body);
  }
}

function frameRecords(body: Uint8Array, deflate: boolean): Uint8Array[] {
  const records: Uint8Array[] = [];
  for (let off = 0; off < body.byteLength; off += MAX_RECORD_DATA) {
    const end = Math.min(off + MAX_RECORD_DATA, body.byteLength);
    const first = off === 0;
    const last = end === body.byteLength;
    const record = new Uint8Array(HEADER_BYTES + end - off);
    const header = new DataView(record.buffer);
    header.setUint8(0, WIRE_VERSION);
    header.setUint8(1, (first ? FLAG_FIRST : 0) | (last ? FLAG_LAST : 0) | (first && deflate ? FLAG_DEFLATE : 0));
    header.setUint32(2, body.byteLength);
    record.set(body.subarray(off, end), HEADER_BYTES);
    records.push(record);
  }
  return records;
}

function parseMessage(body: Uint8Array): WireMessage {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(body));
  } catch {
    throw new WireError("body is not strict UTF-8 JSON");
  }
  return validateMessage(value);
}

interface Codec {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<BufferSource>;
}

/** Returns the deflated input, or null when CompressionStream is unavailable or the output would not be smaller. */
async function deflateRaw(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  let codec: Codec;
  try {
    codec = new CompressionStream("deflate-raw");
  } catch {
    return null;
  }
  return pump(codec, input, input.byteLength - 1);
}

/** Inflates a body, failing as soon as the output exceeds the message limit. */
async function inflateRaw(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  let codec: Codec;
  try {
    codec = new DecompressionStream("deflate-raw");
  } catch {
    throw new WireError("deflate-raw is not supported in this runtime");
  }
  let out: Uint8Array<ArrayBuffer> | null;
  try {
    out = await pump(codec, input, WIRE_LIMITS.messageBytes);
  } catch {
    throw new WireError("corrupt deflate body");
  }
  if (out === null) throw new WireError("inflated body exceeds 16 MiB");
  return out;
}

/** Runs input through a codec and collects the output. Resolves null as soon as the output would exceed limit. */
async function pump(codec: Codec, input: Uint8Array<ArrayBuffer>, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const writer = codec.writable.getWriter();
  const writing = writer.write(input).then(() => writer.close());
  writing.catch(() => {}); // a failure also errors the readable side, where it is reported
  const reader = codec.readable.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(next.value as Uint8Array<ArrayBuffer>); // a codec's output is always ArrayBuffer-backed
  }
  await writing;
  return concat(parts, size);
}

function concat(parts: Uint8Array<ArrayBuffer>[], size: number): Uint8Array<ArrayBuffer> {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(size);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

function validateMessage(value: unknown): WireMessage {
  if (!isPlainObject(value)) throw new WireError("message must be a JSON object");
  switch (value.k) {
    case "hello":
      fields(value, ["k", "proto"]);
      if (value.proto !== 1) throw new WireError("hello.proto must be 1");
      break;
    case "busy":
    case "taken_over":
      fields(value, ["k", "by"]);
      requireString(value, "by");
      break;
    case "takeover":
      fields(value, ["k"]);
      break;
    case "error":
      fields(value, ["k", "code"]);
      requireString(value, "code");
      break;
    case "req":
      fields(value, ["k", "id", "method", "path"], ["body"]);
      requireString(value, "id");
      requireString(value, "method");
      requireString(value, "path");
      if (value.body !== undefined) assertJson(value.body, 1);
      break;
    case "res": {
      fields(value, ["k", "id", "status", "body"]);
      requireString(value, "id");
      const status = value.status;
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 999) {
        throw new WireError("res.status must be an integer from 100 to 999");
      }
      assertJson(value.body, 1);
      break;
    }
    case "open":
      fields(value, ["k", "cid", "path"]);
      requireString(value, "cid");
      requireString(value, "path");
      break;
    case "ready":
      fields(value, ["k", "cid"]);
      requireString(value, "cid");
      break;
    case "frame":
      fields(value, ["k", "cid", "text"]);
      requireString(value, "cid");
      requireString(value, "text");
      break;
    case "close":
      fields(value, ["k", "cid"], ["reason"]);
      requireString(value, "cid");
      if (value.reason !== undefined) requireString(value, "reason");
      break;
    default:
      throw new WireError("unknown message kind");
  }
  return value as WireMessage;
}

function fields(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(o)) {
    if (!required.includes(key) && !optional.includes(key)) throw new WireError(`unexpected field "${key}"`);
  }
  for (const key of required) {
    if (!Object.hasOwn(o, key)) throw new WireError(`missing field "${key}"`);
  }
}

function requireString(o: Record<string, unknown>, key: string): void {
  if (typeof o[key] !== "string") throw new WireError(`field "${key}" must be a string`);
}

/** Rejects anything that JSON cannot represent (undefined, NaN, functions, bigint, class instances) and nesting past the depth limit. */
function assertJson(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH) throw new WireError("JSON nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WireError("non-finite number is not JSON");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) assertJson(value[key], depth + 1);
    return;
  }
  throw new WireError(`${typeof value} is not JSON`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
