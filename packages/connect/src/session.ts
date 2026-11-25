import { ReplayBuffer, type Msg } from "@cgscli/wire";
import type { Pty, PtyFactory } from "./pty.ts";
import { TspHost, type TspCodec } from "./tsp-host.ts";

export type SessionState = "working" | "needs-you" | "idle" | "exited";
export interface Delta { surface: string; body: string }

export interface SessionOptions {
  id: string;
  spawn: PtyFactory;
  cmd: string[];
  cwd?: string;
  env: Record<string, string>;
  codec: TspCodec;
  window?: number;
}

/** One omp process + one pty + one TSP host. Single-writer: the first client to write holds the lock until it leaves. */
export class Session {
  readonly id: string;
  state: SessionState = "idle";
  exitCode: number | null | undefined;
  writer: object | null = null;
  readonly replay: ReplayBuffer<Delta>;
  private pty: Pty;
  private host: TspHost;
  private listeners = new Set<(m: Msg) => void>();

  constructor(o: SessionOptions) {
    this.id = o.id;
    this.replay = new ReplayBuffer<Delta>(o.window ?? 1024);
    this.pty = o.spawn({ cmd: o.cmd, cwd: o.cwd, env: o.env });
    this.host = new TspHost(this.pty, o.codec, {
      onFrame: (surface, body) => {
        const seq = this.replay.push({ surface, body });
        this.emit({ t: "tsp.delta", session: this.id, streamId: surface, seq, ops: body });
      },
      onPassthrough: (bytes) => this.emit({ t: "tsp.raw", session: this.id, data: Buffer.from(bytes).toString("base64") }),
    });
    this.pty.onExit((code) => {
      this.exitCode = code;
      this.state = "exited";
      this.emit({ t: "session.state", id: this.id, state: "exited", code });
    });
  }

  subscribe(cb: (m: Msg) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(m: Msg) { for (const l of this.listeners) l(m); }

  /** Snapshot (per surface) followed by deltas after `lastSeq`, or null seq => snapshot only. */
  attachMessages(lastSeq?: number): Msg[] {
    const deltas = lastSeq === undefined ? null : this.replay.since(lastSeq);
    if (deltas) return deltas.map((d) => ({ t: "tsp.delta", session: this.id, streamId: d.v.surface, seq: d.seq, ops: d.v.body }));
    return [{ t: "tsp.snapshot", session: this.id, streamId: "*", seq: this.replay.lastSeq, doc: this.host.snapshot() }];
  }

  send(surface: string, id: string, text: string) { this.host.sendEvent(surface, id, text); }
  resize(cols: number, rows: number) { this.pty.resize(cols, rows); }
  kill() { this.pty.kill(); }
}
