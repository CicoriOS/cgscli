// TSP APC framing: ESC _ tsp; <body> ESC \   (docs: cgsconnect/tsp-host.md; layout after stencil-hq/tern-sdk, MIT).
// Body semantics (ops, hello reply fields, multi-APC chunk continuation) are [待验证 V6] and are NOT interpreted here:
// frames carry the raw body string. Only the framing and size limits are implemented.

export const TSP_PROTOCOL_VERSION = 1;
export const MAX_APC_BODY = 65536;
export const MAX_BLOB = 16 * 1024 * 1024;

const ESC = 0x1b;
const PREFIX = "tsp;";
const enc = new TextEncoder();
const dec = new TextDecoder();

export type TspFrame = { body: string };
/** Current per-surface document; node shape is defined by the renderer contract (V6). */
export type TspDocument = { surface: string; nodes: unknown };

export function encodeApc(body: string, maxBody = MAX_APC_BODY): Uint8Array {
  const b = enc.encode(PREFIX + body);
  if (b.length > maxBody) throw new RangeError(`APC body ${b.length} exceeds ${maxBody}`);
  const out = new Uint8Array(b.length + 4);
  out.set([ESC, 0x5f], 0); // ESC _
  out.set(b, 2);
  out.set([ESC, 0x5c], b.length + 2); // ESC \
  return out;
}

type State = "ground" | "esc" | "apc" | "apcEsc";

/** Streaming decoder: splits a pty byte stream into passthrough bytes and `tsp;` APC frames. Safe for arbitrary chunk splits. */
export class ApcDecoder {
  private state: State = "ground";
  private buf: number[] = [];
  constructor(private maxBody = MAX_APC_BODY) {}

  feed(bytes: Uint8Array): { passthrough: Uint8Array; frames: TspFrame[] } {
    const pass: number[] = [];
    const frames: TspFrame[] = [];
    for (const c of bytes) {
      switch (this.state) {
        case "ground":
          if (c === ESC) this.state = "esc"; else pass.push(c);
          break;
        case "esc":
          if (c === 0x5f) { this.state = "apc"; this.buf = []; }
          else { pass.push(ESC); this.state = "ground"; if (c === ESC) this.state = "esc"; else pass.push(c); }
          break;
        case "apc":
          if (c === ESC) this.state = "apcEsc";
          else this.push(c);
          break;
        case "apcEsc":
          if (c === 0x5c) {
            this.finish(pass, frames);
          } else { this.push(ESC); this.push(c); this.state = "apc"; }
          break;
      }
    }
    return { passthrough: Uint8Array.from(pass), frames };
  }

  private push(c: number) {
    if (this.buf.length >= this.maxBody) { this.buf = []; this.state = "ground"; throw new RangeError("APC body too large"); }
    this.buf.push(c);
  }

  private finish(pass: number[], frames: TspFrame[]) {
    const s = dec.decode(Uint8Array.from(this.buf));
    this.state = "ground";
    this.buf = [];
    if (s.startsWith(PREFIX)) frames.push({ body: s.slice(PREFIX.length) });
    else { pass.push(ESC, 0x5f, ...enc.encode(s), ESC, 0x5c); } // foreign APC: pass through untouched
  }
}
