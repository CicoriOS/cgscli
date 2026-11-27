// The terminal sessions (TUI) of this device that stand by for remote control (ADR 0027). A live entry is one TUI
// attached to the unit through the daemon tunnel. The tunnel is the registration, so no child process is created for it.
// The TUI's first line is its `live_hello` (cwd, session file, title): until then it is not listed or routable. Browsers
// reach a live entry by its `live:<id>` child id, or by the session file it is running (no duplicate child is spawned).
import { CHUNK_LINE_PREFIX, ChunkAssembler } from "../host/chunks.ts";
import type { ChildStatus, SocketHandlers } from "../host/index.ts";

export const LIVE_PREFIX = "live:";
/** The line a TUI sends to hand the session over to this device's terminal (ADR 0027 section 2). */
export const TAKEN_OVER_LINE = '{"type":"taken_over"}';
const UNKNOWN_LIVE_REASON = "Unknown live session";
const DETACHED_REASON = "The terminal session detached";
/** Tunnel control lines are reserved; RPC input is prefixed so it cannot impersonate one. */
export const REMOTE_ATTACHED_LINE = '{"type":"remote_attached"}';
/** Sent to a TUI when its last browser stream closes: it leaves standby, and its registration stays for the next browser (ADR 0027). */
export const REMOTE_DETACHED_LINE = '{"type":"remote_detached"}';
export const LIVE_READY_LINE = '{"type":"live_ready"}';
export const LIVE_BUSY_LINE = '{"type":"live_busy"}';
export const RPC_INPUT_PREFIX = ">";
/** The id of the `negotiate_protocol` request the registry sends a TUI itself; its response never reaches a browser. */
export const LIVE_NEGOTIATE_ID = "cgs-live-protocol-v2";
const INVALID_CHUNKS_REASON = "The terminal sent an invalid chunked frame";

/** The daemon tunnel as the unit sees it: bytes in, bytes out. */
export interface LiveTunnel {
  send(data: string | Uint8Array): boolean;
  start(onData: (chunk: Uint8Array) => void, onClose: () => void): void;
  close(): void;
}

/** What a TUI reports about itself: its first line, and again whenever it changes. */
export interface LiveHello {
  cwd: string;
  sessionPath?: string;
  title?: string;
  ring: "idle" | "work" | "think";
  level: string;
  unseen: boolean;
  updatedAt: number;
}

interface LiveEntry {
  id: string;
  tunnel: LiveTunnel;
  hello?: LiveHello;
  socket?: LiveSocket;
}

/** One browser stream on a TUI. `negotiated` turns true when the TUI answered the protocol request; browser frames wait for it. */
interface LiveSocket {
  key: string;
  handlers: SocketHandlers;
  ready: boolean;
  negotiated: boolean;
  held: string[];
  chunks: ChunkAssembler;
}

/** Narrows one TUI line: a `live_hello` with the fields the PWA lists by. */
function parseHello(parsed: unknown): LiveHello | undefined {
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || parsed.type !== "live_hello") return undefined;
  if (!("cwd" in parsed) || typeof parsed.cwd !== "string" || !("updatedAt" in parsed) || typeof parsed.updatedAt !== "number") return undefined;
  const sessionPath = "sessionPath" in parsed && typeof parsed.sessionPath === "string" ? parsed.sessionPath : undefined;
  const title = "title" in parsed && typeof parsed.title === "string" ? parsed.title : undefined;
  const ring = "ring" in parsed && (parsed.ring === "work" || parsed.ring === "think") ? parsed.ring : "idle";
  const level = "level" in parsed && typeof parsed.level === "string" ? parsed.level : "";
  const unseen = "unseen" in parsed && parsed.unseen === true;
  return { cwd: parsed.cwd, sessionPath, title, ring, level, unseen, updatedAt: parsed.updatedAt };
}

export class LiveRegistry {
  readonly #by: () => string;
  readonly #entries = new Map<string, LiveEntry>();
  /** The entry each open browser stream routes to, by host key. */
  readonly #keys = new Map<string, LiveEntry>();

  /** `by` names this device's terminal to the browser when a TUI takes the session over. */
  constructor(by: () => string) {
    this.#by = by;
  }

  /** The registered terminals that said hello, shaped as the host's ChildStatus so the PWA lists them alike. */
  list(): ChildStatus[] {
    const out: ChildStatus[] = [];
    for (const entry of this.#entries.values()) {
      const h = entry.hello;
      if (!h) continue;
      out.push({ id: LIVE_PREFIX + entry.id, cwd: h.cwd, sessionPath: h.sessionPath, title: h.title, updatedAt: h.updatedAt, ring: h.ring, level: h.level, unseen: h.unseen });
    }
    return out;
  }

  /** The live terminal running this session file, if any. Used so a browser does not spawn a second child for it. */
  findBySession(sessionPath: string): ChildStatus | undefined {
    return this.list().find((c) => c.sessionPath === sessionPath);
  }

  /** A TUI attached on `channel`. Refused unless remote access is on: a TUI registers only while it is enabled. */
  attach(channel: string, tunnel: LiveTunnel, enabled: boolean): void {
    const id = channel.startsWith(LIVE_PREFIX) ? channel.slice(LIVE_PREFIX.length) : "";
    if (!enabled || !id) {
      tunnel.close();
      return;
    }
    const previous = this.#entries.get(id);
    if (previous) this.#end(previous, DETACHED_REASON);
    const entry: LiveEntry = { id, tunnel };
    this.#entries.set(id, entry);
    const decoder = new TextDecoder();
    let rest = "";
    tunnel.start(
      (chunk) => {
        rest += decoder.decode(chunk, { stream: true });
        for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
          const line = rest.slice(0, i);
          rest = rest.slice(i + 1);
          if (!line.trim() || this.#entries.get(id) !== entry) continue;
          this.#line(entry, line);
        }
      },
      () => this.#end(entry, DETACHED_REASON),
    );
  }

  /** Attaches a browser stream to the live session named by `?child=live:<id>`. False when the path names no live session. */
  open(key: string, path: string, handlers: SocketHandlers): boolean {
    const child = new URL(path, "http://host.invalid").searchParams.get("child");
    if (!child || !child.startsWith(LIVE_PREFIX)) return false;
    const entry = this.#entries.get(child.slice(LIVE_PREFIX.length));
    if (!entry || !entry.hello) {
      handlers.onClose(key, UNKNOWN_LIVE_REASON);
    } else if (entry.socket) {
      handlers.onClose(key, "The terminal session already has a controller");
    } else {
      entry.socket = { key, handlers, ready: false, negotiated: false, held: [], chunks: new ChunkAssembler() };
      this.#keys.set(key, entry);
      entry.tunnel.send(`${REMOTE_ATTACHED_LINE}\n`);
    }
    return true;
  }

  /** Forwards a browser frame to its TUI. False when `key` is not a live stream. */
  frame(key: string, text: string): boolean {
    const entry = this.#keys.get(key);
    if (!entry) return false;
    const line = text.trimEnd();
    const socket = entry.socket;
    if (socket?.ready && !line.includes("\n")) {
      if (socket.negotiated) entry.tunnel.send(`${RPC_INPUT_PREFIX}${line}\n`);
      else socket.held.push(line);
    }
    return true;
  }

  /** Detaches a browser stream from its TUI. False when `key` is not a live stream. */
  close(key: string): boolean {
    const entry = this.#keys.get(key);
    if (!entry) return false;
    this.#keys.delete(key);
    entry.socket = undefined;
    entry.tunnel.send(`${REMOTE_DETACHED_LINE}\n`);
    return true;
  }

  /** Ends every registration: remote access went off. */
  closeAll(): void {
    for (const entry of [...this.#entries.values()]) this.#end(entry, DETACHED_REASON);
  }

  #line(entry: LiveEntry, line: string): void {
    if (line === TAKEN_OVER_LINE) {
      this.#takeOver(entry);
      return;
    }
    if (line === LIVE_READY_LINE) {
      const socket = entry.socket;
      if (socket && !socket.ready) {
        socket.ready = true;
        // Before the browser's first frame: under protocol v1 omp replaces a response over 1 MiB (a long session's
        // get_entries) with "RPC response exceeded the transport limit". Under v2 it arrives as chunks, joined below.
        const request = { type: "negotiate_protocol", id: LIVE_NEGOTIATE_ID, protocolVersion: 2 };
        entry.tunnel.send(`${RPC_INPUT_PREFIX}${JSON.stringify(request)}\n`);
        socket.handlers.onOpen(socket.key);
      }
      return;
    }
    if (line === LIVE_BUSY_LINE) {
      const socket = this.#removeSocket(entry);
      socket?.handlers.onClose(socket.key, "The terminal is busy locally");
      return;
    }
    const socket = entry.socket;
    // `live_hello` starts with a type field and is the only registration metadata frame.
    if (line.startsWith('{"type":"live_hello"')) {
      const hello = parseHello(parseJson(line));
      if (hello) entry.hello = hello;
      return;
    }
    if (!socket?.ready) return;
    if (!socket.negotiated && line.includes(LIVE_NEGOTIATE_ID)) {
      const answer = parseJson(line);
      if (typeof answer === "object" && answer !== null && "type" in answer && answer.type === "response" && "id" in answer && answer.id === LIVE_NEGOTIATE_ID) {
        // An older TUI refuses the command: the stream then stays on protocol v1.
        socket.negotiated = true;
        for (const held of socket.held.splice(0)) entry.tunnel.send(`${RPC_INPUT_PREFIX}${held}\n`);
        return;
      }
    }
    if (line.startsWith(CHUNK_LINE_PREFIX)) {
      let whole: string | undefined;
      try {
        whole = socket.chunks.push(line);
      } catch {
        this.#abandon(entry, INVALID_CHUNKS_REASON);
        return;
      }
      if (whole !== undefined) socket.handlers.onFrame(socket.key, whole);
    } else if (socket.chunks.open) {
      this.#abandon(entry, INVALID_CHUNKS_REASON);
    } else {
      socket.handlers.onFrame(socket.key, line);
    }
  }

  /** The TUI's stream is not a valid chunk sequence: the browser stream closes, the TUI leaves standby, its registration stays. */
  #abandon(entry: LiveEntry, reason: string): void {
    const socket = this.#removeSocket(entry);
    if (!socket) return;
    entry.tunnel.send(`${REMOTE_DETACHED_LINE}\n`);
    socket.handlers.onClose(socket.key, reason);
  }

  /** The TUI handed the session to this terminal: browsers learn it by an explicit `taken_over`, not a silent drop. */
  #takeOver(entry: LiveEntry): void {
    const socket = this.#removeSocket(entry);
    if (!socket) return;
    if (socket.handlers.onTakenOver) socket.handlers.onTakenOver(socket.key, this.#by());
    else socket.handlers.onClose(socket.key, "taken_over");
  }

  /** The TUI went away: every browser stream on it closes. */
  #end(entry: LiveEntry, reason: string): void {
    if (this.#entries.get(entry.id) !== entry) return;
    this.#entries.delete(entry.id);
    const socket = this.#removeSocket(entry);
    socket?.handlers.onClose(socket.key, reason);
    entry.tunnel.close();
  }

  #removeSocket(entry: LiveEntry): LiveEntry["socket"] {
    const socket = entry.socket;
    if (socket) this.#keys.delete(socket.key);
    entry.socket = undefined;
    return socket;
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
