// Relay envelope (docs: cgsconnect/relay-protocol.md, a PROPOSAL; there is no relay implementation to match yet).
// `ctl` bodies are not specified by the document; the ops below are this implementation's assumption and must be
// reconciled with the relay spec before the server exists.
export const ENVELOPE_VERSION = 1;

export type CtlBody =
  | { op: "open" }                       // relay -> device: a client wants a session on `sid`
  | { op: "close"; reason?: string }     // either direction
  | { op: "error"; code: string; message?: string }; // relay -> peer: rate limit, unknown device, ...

export type Envelope =
  | { v: 1; type: "data"; sid: string; seq: number; payload: string }   // payload: base64 Noise transport message
  | { v: 1; type: "ctl"; sid: string; seq: number; payload: CtlBody };

export function parseEnvelope(text: string): Envelope | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.v !== ENVELOPE_VERSION || typeof o.sid !== "string" || typeof o.seq !== "number") return null;
  if (o.type === "data" && typeof o.payload === "string") return { v: 1, type: "data", sid: o.sid, seq: o.seq, payload: o.payload };
  if (o.type === "ctl" && o.payload && typeof o.payload === "object" && typeof (o.payload as { op?: unknown }).op === "string") return { v: 1, type: "ctl", sid: o.sid, seq: o.seq, payload: o.payload as CtlBody };
  return null;
}
