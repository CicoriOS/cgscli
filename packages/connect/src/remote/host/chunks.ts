// Reassembles omp's protocol v2 `rpc_chunk` lines into the logical frame they carry.
//
// The host asks every child for protocol v2 (`negotiate_protocol`). Under v1 a response over 1 MiB (a long session's
// `get_entries`) is replaced by "RPC response exceeded the transport limit"; under v2 it arrives as base64 chunks of at
// most 256 KiB and the whole frame may be up to 64 MiB. The limits below are omp's (modes/rpc/rpc-frame.ts).
import { Buffer } from "node:buffer";

const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;

/** omp serializes a chunk with `type` first, so the host can tell one apart without parsing every line. */
export const CHUNK_LINE_PREFIX = '{"type":"rpc_chunk"';

interface Pending {
  chunkId: string;
  count: number;
  byteLength: number;
  next: number;
  parts: Buffer[];
  received: number;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export class ChunkAssembler {
  #pending: Pending | undefined;

  /** The JSON text of the whole frame once its last chunk arrives, otherwise undefined. Throws when the stream is not a valid chunk sequence. */
  push(line: string): string | undefined {
    const chunk: Record<string, unknown> = JSON.parse(line);
    const { chunkId, index, count, byteLength, data } = chunk;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 ||
      !isCount(index) || !isCount(count) || !isCount(byteLength) ||
      count < 1 || index >= count || byteLength > MAX_REASSEMBLED_BYTES || count * MAX_CHUNK_BYTES < byteLength ||
      typeof data !== "string"
    ) {
      throw new Error("invalid rpc chunk");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.byteLength > MAX_CHUNK_BYTES) throw new Error("rpc chunk is larger than the transport allows");
    if (!this.#pending) {
      if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
      this.#pending = { chunkId, count, byteLength, next: 0, parts: [], received: 0 };
    }
    const p = this.#pending;
    if (p.chunkId !== chunkId || p.count !== count || p.byteLength !== byteLength || p.next !== index) {
      this.#pending = undefined;
      throw new Error("rpc chunk sequence mismatch");
    }
    p.parts.push(bytes);
    p.received += bytes.byteLength;
    p.next++;
    if (p.received > p.byteLength) {
      this.#pending = undefined;
      throw new Error("rpc chunk sequence exceeds its declared length");
    }
    if (p.next < p.count) return undefined;
    this.#pending = undefined;
    if (p.received !== p.byteLength) throw new Error("rpc chunk sequence is shorter than declared");
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(p.parts));
  }

  /** Whether a frame is half way through; no other line may arrive until it ends. */
  get open(): boolean {
    return this.#pending !== undefined;
  }
}
