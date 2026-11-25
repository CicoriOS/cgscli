// Shared contract between cgsconnect and clients (docs: cgsconnect/protocol.md). Encoding: JSON text frames.
// O3 (local transport) is undecided: all code talks to `Duplex`, never to a concrete socket type.

export const PROTO_VERSION = 1;

export type ClientKind = "desktop" | "web" | "cli";
export type ErrorBody = { code: string; message: string; retryable: boolean };

export type Hello = { t: "hello"; proto: [number, number]; client: { kind: ClientKind; version: string }; profile: { name: string; renders: string[] } };
export type Welcome = { t: "welcome"; proto: number; connectVersion: string; ompVersion: string | null; features: string[] };
export type ErrorMsg = { t: "error" } & ErrorBody;

/** Every post-handshake message: `t` is "<family>.<verb>"; family in session|tsp|event|account|agents|devices|system. */
export type Msg = { t: string; [k: string]: unknown };

/** Message-oriented bidirectional channel (local socket, loopback WS, or E2E relay session all implement this). */
export interface Duplex {
  send(msg: Msg): void;
  onMessage(cb: (msg: Msg) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): void;
}
