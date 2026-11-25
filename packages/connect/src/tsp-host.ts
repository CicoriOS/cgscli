import { ApcDecoder, encodeApc } from "@cgscli/wire";
import type { Pty } from "./pty.ts";

/**
 * Wire-level body semantics are [待验证 V6]; the host therefore takes them as an explicit codec instead of guessing.
 * Known facts used here: hello body has q:"hello"; send event is {ev:"send",sf,id,text}; DA1 precedes hello.
 */
export interface TspCodec {
  /** Parse a frame body; return null if not JSON. */
  parse(body: string): Record<string, unknown> | null;
  /** Body of the hello reply (capabilities, version, credits). */
  helloReply(hello: Record<string, unknown>): string;
  /** Body of the ack for a frame, or null if the frame needs none. */
  ack(frame: Record<string, unknown>): string | null;
  /** Fold an op frame into the surface document; return the new document. */
  apply(doc: unknown, frame: Record<string, unknown>): unknown;
  /** Surface the frame belongs to, or null. */
  surface(frame: Record<string, unknown>): string | null;
}

export interface HostEvents {
  /** Frame applied to a surface; `body` is forwarded to clients as a delta. */
  onFrame(surface: string, body: string): void;
  /** Non-TSP terminal bytes for the xterm.js fallback. */
  onPassthrough(bytes: Uint8Array): void;
}

const DA1 = /\x1b\[0?c/;
const DA1_REPLY = "\x1b[?62;c";

export class TspHost {
  private dec = new ApcDecoder();
  private docs = new Map<string, unknown>();
  constructor(private pty: Pty, private codec: TspCodec, private ev: HostEvents) {
    pty.onData((d) => this.feed(d));
  }

  private feed(d: Uint8Array) {
    const { passthrough, frames } = this.dec.feed(d);
    if (passthrough.length) {
      if (DA1.test(new TextDecoder().decode(passthrough))) this.pty.write(DA1_REPLY);
      this.ev.onPassthrough(passthrough);
    }
    for (const f of frames) {
      const frame = this.codec.parse(f.body);
      if (!frame) continue;
      if (frame.q === "hello") { this.pty.write(encodeApc(this.codec.helloReply(frame))); continue; }
      const ack = this.codec.ack(frame);
      if (ack !== null) this.pty.write(encodeApc(ack)); // local ack: never wait for a client round trip
      const sf = this.codec.surface(frame);
      if (sf === null) continue;
      this.docs.set(sf, this.codec.apply(this.docs.get(sf), frame));
      this.ev.onFrame(sf, f.body);
    }
  }

  snapshot(): Record<string, unknown> { return Object.fromEntries(this.docs); }

  /** Structured client event -> TSP event written to the pty. Only `send` has a known encoding. */
  sendEvent(surface: string, id: string, text: string) {
    this.pty.write(encodeApc(JSON.stringify({ ev: "send", sf: surface, id, text })));
  }
}
