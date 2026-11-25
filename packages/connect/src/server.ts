import { PROTO_VERSION, type Duplex, type Msg } from "@cgscli/wire";
import { Session, type SessionOptions } from "./session.ts";
import type { RemoteLink } from "./contracts.ts";

export interface ServerOptions {
  connectVersion: string;
  ompVersion: string | null;
  /** Build session options for a new session (profile, cmd, codec). */
  newSession(id: string, req: { cwd?: string; model?: string }): SessionOptions;
  /** Enables devices.pairing / devices.list. */
  remote?: RemoteLink;
}

const err = (code: string, message: string, retryable = false): Msg => ({ t: "error", code, message, retryable });
const str = (m: Msg, k: string): string | undefined => (typeof m[k] === "string" ? m[k] : undefined);

function protoRange(m: Msg): [number, number] | null {
  const p = m.proto;
  return Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" ? [p[0], p[1]] : null;
}

function resumeSeq(m: Msg): number | undefined {
  const r = m.resume;
  if (!Array.isArray(r)) return undefined;
  const first: unknown = r[0];
  if (first && typeof first === "object" && "lastSeq" in first && typeof first.lastSeq === "number") return first.lastSeq;
  return undefined;
}

/** Protocol server: one instance serves any number of Duplex channels (local or remote). */
export class Server {
  readonly sessions = new Map<string, Session>();
  private n = 0;
  constructor(private o: ServerOptions) {}

  serve(ch: Duplex) {
    let ready = false;
    let unsub: (() => void) | null = null;
    const me = {};
    ch.onClose(() => { unsub?.(); for (const s of this.sessions.values()) if (s.writer === me) s.writer = null; });
    ch.onMessage((m) => {
      if (!ready) {
        if (m.t !== "hello") return ch.send(err("hello-required", "first message must be hello"));
        const range = protoRange(m);
        if (!range || range[0] > PROTO_VERSION || range[1] < PROTO_VERSION) return ch.send(err("proto-unsupported", `server speaks ${PROTO_VERSION}`));
        ready = true;
        return ch.send({ t: "welcome", proto: PROTO_VERSION, connectVersion: this.o.connectVersion, ompVersion: this.o.ompVersion, features: ["send"] });
      }
      try { unsub = this.handle(ch, me, m, unsub); } catch (e) { ch.send(err("internal", e instanceof Error ? e.message : String(e))); }
    });
  }

  private handle(ch: Duplex, me: object, m: Msg, unsub: (() => void) | null): (() => void) | null {
    switch (m.t) {
      case "session.list":
        ch.send({ t: "session.list", sessions: [...this.sessions.values()].map((s) => ({ id: s.id, state: s.state })) });
        return unsub;
      case "session.create": {
        const id = `s${++this.n}`;
        this.sessions.set(id, new Session(this.o.newSession(id, { cwd: str(m, "cwd"), model: str(m, "model") })));
        ch.send({ t: "session.created", id });
        return unsub;
      }
      case "session.open": {
        const s = this.sessions.get(str(m, "id") ?? "");
        if (!s) { ch.send(err("no-session", `unknown session ${str(m, "id")}`)); return unsub; }
        unsub?.();
        for (const x of s.attachMessages(resumeSeq(m))) ch.send(x);
        return s.subscribe((x) => ch.send(x));
      }
      case "event.send": {
        const s = this.sessions.get(str(m, "session") ?? "");
        const surface = str(m, "surface"), id = str(m, "id"), text = str(m, "text");
        if (!s || surface === undefined || id === undefined || text === undefined) { ch.send(err("bad-request", "event.send needs session, surface, id, text")); return unsub; }
        if (s.writer && s.writer !== me) { ch.send(err("not-writer", "session has another writer")); return unsub; }
        s.writer = me;
        s.send(surface, id, text);
        return unsub;
      }
      case "devices.pairing":
      case "devices.list": {
        const remote = this.o.remote;
        if (!remote) { ch.send(err("unsupported", "remote access is not enabled")); return unsub; }
        const work = m.t === "devices.pairing" ? remote.pairing().then((p) => ({ t: "devices.pairing", ...p })) : remote.devices().then((devices) => ({ t: "devices.list", devices }));
        void work.then((r) => ch.send(r), (e) => ch.send(err("remote", e instanceof Error ? e.message : String(e), true)));
        return unsub;
      }
      case "session.delete": case "session.archive": {
        const id = str(m, "id") ?? "";
        this.sessions.get(id)?.kill();
        if (m.t === "session.delete") this.sessions.delete(id);
        return unsub;
      }
      default:
        ch.send(err("unsupported", `${m.t} not supported`));
        return unsub;
    }
  }

  close() { for (const s of this.sessions.values()) s.kill(); }
}
