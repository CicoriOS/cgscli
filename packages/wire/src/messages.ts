import type { Msg } from "./protocol.ts";

// Proposal shapes from cgsconnect/protocol.md; the body of tsp.* ops follows TSP (V6) and is carried opaquely.
export const FAMILIES = ["session", "tsp", "event", "account", "agents", "devices", "system"] as const;
export type Family = (typeof FAMILIES)[number];

export type StreamResume = { streamId: string; lastSeq: number };

export type SessionMsg =
  | { t: "session.list" }
  | { t: "session.open"; id: string; resume?: StreamResume[] }
  | { t: "session.create"; cwd?: string; model?: string }
  | { t: "session.archive" | "session.delete"; id: string }
  | { t: "session.state"; id: string; state: "working" | "needs-you" | "idle" | "exited" };

/** snapshot first, then deltas; one stream per surface; `seq` monotonically increasing per stream. */
export type TspMsg =
  | { t: "tsp.snapshot"; session: string; streamId: string; seq: number; doc: unknown }
  | { t: "tsp.delta"; session: string; streamId: string; seq: number; ops: string };

/** Structured events only; never raw keystrokes (ADR 0011). */
export type EventMsg =
  | { t: "event.send"; session: string; surface: string; id: string; text: string }
  | { t: "event.click"; session: string; surface: string; node: string }
  | { t: "event.approve"; session: string; id: string; allow: boolean }
  | { t: "event.form"; session: string; id: string; values: Record<string, unknown> };

export function family(m: Msg): Family | null {
  const f = m.t.split(".", 1)[0] as Family;
  return (FAMILIES as readonly string[]).includes(f) ? f : null;
}

export function isMsg(v: unknown): v is Msg {
  return typeof v === "object" && v !== null && typeof (v as Msg).t === "string";
}
