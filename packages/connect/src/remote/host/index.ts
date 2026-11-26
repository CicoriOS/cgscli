// Session host of the remote connection: one headless `cgs --mode rpc-ui` per open session behind the bridge's HTTP and
// WebSocket surface, with no sockets of its own. Ported from ompweb-desktop bridge/server.ts (ADR 0035); the transport
// is the caller's: `request` answers what the bridge answers over HTTP, and `open`/`frame`/`close` stand for the
// bridge's per-child WebSocket (wire messages req/res and open/frame/close, ADR 0036).
import fs from "node:fs";
import path from "node:path";
import { UNKNOWN_CHILD_REASON } from "../wire/index.ts";
import { createStore, type Store } from "./store.ts";

export type { Completion, SessionRow, Sessions, Store, Workspace } from "./store.ts";
export { createStore } from "./store.ts";

export type Ring = "idle" | "work" | "think";

/** What GET /api/children lists for one omp process. */
export interface ChildStatus {
  id: string;
  cwd: string;
  sessionPath?: string;
  title?: string;
  updatedAt: number;
  ring: Ring;
  level: string;
  unseen: boolean;
}

export interface HostOptions {
  agentDir: string;
  /** The machine's name: what the page shows as the device being controlled. */
  device: string;
  /** The omp command: `[cgs, "--mode", "rpc-ui"]` in production. */
  command: string[];
  /** Shown as a workspace even before anything is remembered or used; "" for none. */
  defaultCwd?: string;
  env?: Record<string, string | undefined>;
  childLimit?: number;
  idleMs?: number;
  attachGraceMs?: number;
  reapIntervalMs?: number;
  rpcTimeoutMs?: number;
  workspacesFile?: string;
  sessionsDir?: string;
}

export interface HostResponse {
  status: number;
  body: unknown;
}

export interface SocketHandlers {
  onOpen(cid: string): void;
  onFrame(cid: string, text: string): void;
  onClose(cid: string, reason: string): void;
}

export interface Host {
  request(req: { method: string; path: string; body?: unknown }): Promise<HostResponse>;
  /** Attaches stream `cid` to a child: `/ws?child=<id>`, or the child named by `cid` itself when the path has no `child`. */
  open(cid: string, wsPath: string, handlers: SocketHandlers): void;
  frame(cid: string, text: string): void;
  /** Detaches stream `cid`; the caller is closing it, so `onClose` is not called. */
  close(cid: string): void;
  shutdown(): Promise<void>;
}

// What the host reads of omp's JSONL frames. Everything else stays untyped on purpose.
type Frame = {
  type?: string;
  id?: string;
  method?: string;
  targetId?: string;
  messageId?: string;
  command?: string;
  success?: boolean;
  error?: string;
  sessionSettled?: boolean;
  resolved?: string;
  toolName?: string;
  html?: unknown;
  message?: { role?: string; content?: unknown } | string | null;
  assistantMessageEvent?: { type?: string; partial?: { role?: string; content?: unknown } };
  data?: { sessionFile?: string; thinkingLevel?: string; isStreaming?: boolean; isSettled?: boolean; cancelled?: boolean };
};

interface Socket {
  cid: string;
  child: Child;
  handlers: SocketHandlers;
  snapshotId?: string;
}

interface Child {
  status: ChildStatus;
  proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  sockets: Map<string, Socket>;
  dialogs: Map<string, Frame>;
  partial?: Frame;
  queue?: Frame;
  admission: Set<string>;
  ready: boolean;
  stopping: boolean;
  idleSince: number;
  requestedPath?: string;
  rebinding?: Promise<void>;
  /** The latest session-file bind (path and title read from disk); a child is ready only once it settled. */
  binding?: Promise<void>;
  pending: Map<string, (response?: Frame) => void>;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const MAX_PARTIAL_CHARS = 1024 * 1024;
const TITLE_CHARS = 80;
/** Methods of `extension_ui_request` a page answers with a dialog. */
const DIALOG_METHODS: Record<string, true> = { form: true, select: true, confirm: true, input: true, editor: true };
const SESSION_SELECTION: Record<string, true> = { new_session: true, switch_session: true, open_session: true, branch: true };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : "")).join("");
}

/** The ring state a frame asks for while a prompt runs, if any. */
function ringFor(f: Frame): Ring | undefined {
  if (f.type === "tool_execution_start") return "work";
  if (f.type !== "message_update") return undefined;
  const ev = f.assistantMessageEvent?.type ?? "";
  if (ev.startsWith("thinking_") && ev !== "thinking_end") return "think";
  if (ev.startsWith("text_") || ev.startsWith("toolcall_") || ev === "thinking_end") return "work";
  return undefined;
}

/** Whether a dialog request is one the page answers (a form needs its HTML). */
function isDialog(f: Frame): boolean {
  if (!f.id || !f.method || !DIALOG_METHODS[f.method]) return false;
  return f.method !== "form" || typeof f.html === "string";
}

const fileKey = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

export function createHost(opts: HostOptions): Host {
  const childLimit = opts.childLimit ?? 8;
  const idleMs = opts.idleMs ?? 15 * 60_000;
  const attachGraceMs = opts.attachGraceMs ?? 5_000;
  const reapIntervalMs = opts.reapIntervalMs ?? 60_000;
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 30_000;
  const defaultCwd = opts.defaultCwd ?? "";
  const store: Store = createStore({ agentDir: opts.agentDir, defaultCwd, workspacesFile: opts.workspacesFile, sessionsDir: opts.sessionsDir });
  const children = new Map<string, Child>();
  const opening = new Map<string, Promise<ChildStatus>>();
  const sockets = new Map<string, Socket>();
  let exiting = false;

  const isIdle = (child: Child): boolean =>
    child.ready && !child.stopping && child.sockets.size === 0 && child.status.ring === "idle" && child.admission.size === 0 && child.dialogs.size === 0;

  function write(child: Child, frame: unknown): void {
    child.proc.stdin.write(`${JSON.stringify(frame)}\n`);
    child.proc.stdin.flush();
  }

  function rpc(child: Child, type: string, args: Record<string, unknown> = {}): Promise<Frame["data"]> {
    const id = `host-${crypto.randomUUID()}`;
    const { promise, resolve, reject } = Promise.withResolvers<Frame["data"]>();
    const finish = (frame?: Frame): void => {
      clearTimeout(timer);
      child.pending.delete(id);
      if (frame?.success) resolve(frame.data);
      else reject(new Error(frame?.error ?? `omp did not answer ${type}`));
    };
    const timer = setTimeout(finish, rpcTimeoutMs);
    child.pending.set(id, finish);
    try {
      write(child, { type, id, ...args });
    } catch {
      finish();
    }
    return promise;
  }

  async function setFile(child: Child, sessionFile: string): Promise<void> {
    const sessionPath = fileKey(sessionFile);
    if (child.status.sessionPath === sessionPath) return;
    child.status.sessionPath = sessionPath;
    child.status.unseen = false;
    child.status.updatedAt = Date.now();
    // A fork changes file identity in this same process.
    child.status.title = await store.title(sessionPath).catch(() => undefined);
  }

  function publish(child: Child, line: string): void {
    let f: Frame;
    try {
      f = JSON.parse(line);
    } catch {
      return;
    }
    const s = child.status;
    if (f.type === "agent_start") {
      s.ring = "work";
      s.unseen = false;
      s.updatedAt = Date.now();
    } else if (f.type === "session_settled" || (f.type === "prompt_result" && f.sessionSettled)) {
      if (s.ring !== "idle") {
        s.unseen = child.sockets.size === 0;
        s.updatedAt = child.idleSince = Date.now();
      }
      s.ring = "idle";
      child.partial = undefined;
    } else if (s.ring !== "idle") {
      s.ring = ringFor(f) ?? s.ring;
    }
    if (f.type === "thinking_level_changed" && f.resolved) s.level = f.resolved;
    if (f.type === "queue_update") child.queue = f;
    const message = typeof f.message === "object" && f.message ? f.message : f.assistantMessageEvent?.partial;
    if (f.type === "message_start" && message?.role === "user" && !s.title) {
      s.title = textOf(message.content).replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS) || "…";
      s.updatedAt = Date.now();
    }
    if ((f.type === "message_start" || f.type === "message_update") && message?.role === "assistant") {
      // A single bounded partial, never the transcript: get_entries already includes finished messages.
      child.partial = line.length <= MAX_PARTIAL_CHARS ? f : undefined;
    } else if (f.type === "agent_end" || (f.type === "message_end" && child.partial?.messageId === f.messageId)) {
      child.partial = undefined;
    }
    if (f.type === "extension_ui_request") {
      if (f.method === "cancel" && f.targetId) child.dialogs.delete(f.targetId);
      else if (f.id && isDialog(f)) child.dialogs.set(f.id, f);
      else if (f.method === "setTitle") s.updatedAt = Date.now();
    }
    if (f.type === "tool_execution_end" && f.toolName === "ask") {
      for (const [id, dialog] of child.dialogs) if (dialog.method === "form") child.dialogs.delete(id);
    }
    if (f.type === "response") {
      if (f.command === "get_state" && f.success) {
        if (f.data?.sessionFile) child.binding = setFile(child, f.data.sessionFile);
        s.level = f.data?.thinkingLevel ?? s.level;
        if (!(f.data?.isSettled ?? !f.data?.isStreaming) && s.ring === "idle") s.ring = "work";
      }
      if (f.command === "fork" && f.success && !f.data?.cancelled) {
        const rebinding = rpc(child, "get_state").then(
          () => {},
          () => {},
        );
        child.rebinding = rebinding;
        void rebinding.finally(() => {
          if (child.rebinding === rebinding) child.rebinding = undefined;
        });
        child.queue = undefined;
      }
      if (f.id && child.admission.delete(f.id)) child.idleSince = Date.now();
      const internal = f.id && child.pending.get(f.id);
      if (internal) {
        internal(f);
        return;
      }
    }
    for (const socket of child.sockets.values()) {
      if (f.type === "response" && f.id !== undefined && f.id === socket.snapshotId) {
        socket.snapshotId = undefined;
        if (f.success) {
          socket.handlers.onFrame(
            socket.cid,
            JSON.stringify({ type: "bridge_snapshot", ring: s.ring, level: s.level, partial: child.partial, dialogs: [...child.dialogs.values()], queue: child.queue }),
          );
        }
      }
      socket.handlers.onFrame(socket.cid, line);
    }
  }

  function stop(child: Child): void {
    if (child.stopping) return;
    child.stopping = true;
    child.proc.kill();
  }

  function spawn(cwd: string, requestedPath?: string): Child {
    const proc = Bun.spawn(opts.command, {
      cwd,
      env: { ...process.env, ...opts.env, PI_CODING_AGENT_DIR: opts.agentDir },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const child: Child = {
      proc,
      requestedPath,
      ready: false,
      stopping: false,
      idleSince: Date.now(),
      sockets: new Map(),
      dialogs: new Map(),
      admission: new Set(),
      pending: new Map(),
      status: { id: crypto.randomUUID(), cwd, ring: "idle", level: "high", updatedAt: Date.now(), unseen: false },
    };
    children.set(child.status.id, child);
    void (async () => {
      try {
        const decoder = new TextDecoder();
        let rest = "";
        for await (const chunk of proc.stdout) {
          rest += decoder.decode(chunk, { stream: true });
          for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
            const line = rest.slice(0, i);
            rest = rest.slice(i + 1);
            if (line.trim()) publish(child, line);
          }
        }
      } catch (e) {
        console.error(e);
        stop(child);
      } finally {
        const exitCode = await proc.exited;
        children.delete(child.status.id);
        for (const finish of child.pending.values()) finish();
        for (const socket of [...child.sockets.values()]) {
          sockets.delete(socket.cid);
          socket.handlers.onFrame(socket.cid, JSON.stringify({ type: "bridge_exit", exitCode }));
          socket.handlers.onClose(socket.cid, "omp exited");
        }
        child.sockets.clear();
      }
    })();
    return child;
  }

  async function startChild(cwd: string, sessionPath?: string): Promise<ChildStatus> {
    if (exiting) throw new ApiError("The host is shutting down", 503);
    if (children.size >= childLimit) {
      const now = Date.now();
      const oldest = [...children.values()]
        .filter((c) => isIdle(c) && now - c.idleSince >= attachGraceMs)
        .sort((a, b) => a.idleSince - b.idleSince)[0];
      if (!oldest) throw new ApiError(`All ${childLimit} omp session slots are in use`, 409);
      stop(oldest);
      await oldest.proc.exited;
      children.delete(oldest.status.id);
      // A concurrent request may have claimed the slot while we waited.
      return startChild(cwd, sessionPath);
    }
    // Remembered workspaces may be on ephemeral storage.
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(cwd, sessionPath);
    try {
      if (sessionPath && (await rpc(child, "switch_session", { sessionPath }))?.cancelled) throw new ApiError("Switch cancelled", 409);
      await rpc(child, "get_state");
      await child.binding;
      child.ready = true;
      child.idleSince = Date.now();
      return child.status;
    } catch (e) {
      stop(child);
      throw e;
    }
  }

  async function openChild(cwd: string, file?: string): Promise<ChildStatus> {
    if (!file) return startChild(cwd);
    const sessionPath = fileKey(file);
    const rebinding = [...children.values()].flatMap((c) => (c.rebinding ? [c.rebinding] : []));
    if (rebinding.length) await Promise.all(rebinding);
    const existing = [...children.values()].find((c) => (c.status.sessionPath ?? c.requestedPath) === sessionPath && c.ready);
    if (existing && !existing.stopping) {
      existing.idleSince = Date.now();
      return existing.status;
    }
    const pending = opening.get(sessionPath);
    if (pending) return pending;
    const task = (async () => {
      if (existing) await existing.proc.exited;
      return startChild(cwd, sessionPath);
    })();
    opening.set(sessionPath, task);
    try {
      return await task;
    } finally {
      opening.delete(sessionPath);
    }
  }

  async function route(req: { method: string; path: string; body?: unknown }): Promise<HostResponse> {
    const url = new URL(req.path, "http://host.invalid");
    const pathname = url.pathname;
    if (req.method === "GET") {
      if (pathname === "/api/info") return { status: 200, body: { cwd: defaultCwd, agentDir: opts.agentDir, device: opts.device } };
      if (pathname === "/api/children") return { status: 200, body: { children: [...children.values()].filter((c) => c.ready && !c.stopping).map((c) => c.status) } };
      if (pathname === "/api/sessions") return { status: 200, body: await store.sessions() };
      if (pathname === "/api/complete") return { status: 200, body: await store.complete(url.searchParams.get("path") ?? "/") };
    }
    if (req.method !== "POST") return { status: 404, body: { error: "not found" } };
    const body = (typeof req.body === "object" ? req.body : null) as { cwd?: unknown; sessionPath?: unknown } | null;
    if (typeof body?.cwd !== "string" || !path.isAbsolute(body.cwd)) return { status: 400, body: { error: "cwd must be an absolute path" } };
    const cwd = path.resolve(body.cwd);
    if (pathname === "/api/workspace") {
      await store.remember(cwd);
      return { status: 200, body: { cwd } };
    }
    if (pathname === "/api/children") {
      const file = body.sessionPath;
      if (file !== undefined && (typeof file !== "string" || !path.isAbsolute(file))) return { status: 400, body: { error: "sessionPath must be an absolute path" } };
      return { status: file ? 200 : 201, body: await openChild(cwd, file) };
    }
    return { status: 404, body: { error: "not found" } };
  }

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const child of children.values()) if (isIdle(child) && now - child.idleSince >= idleMs) stop(child);
  }, reapIntervalMs);
  reaper.unref();

  return {
    async request(req) {
      try {
        return await route(req);
      } catch (e) {
        return { status: e instanceof ApiError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } };
      }
    },

    open(cid, wsPath, handlers) {
      const childId = new URL(wsPath, "http://host.invalid").searchParams.get("child") ?? cid;
      const child = children.get(childId);
      if (!child?.ready || child.stopping || sockets.has(cid)) {
        handlers.onClose(cid, UNKNOWN_CHILD_REASON);
        return;
      }
      const socket: Socket = { cid, child, handlers };
      sockets.set(cid, socket);
      child.sockets.set(cid, socket);
      child.status.unseen = false;
      handlers.onOpen(cid);
    },

    frame(cid, text) {
      const socket = sockets.get(cid);
      const child = socket?.child;
      if (!socket || !child || child.stopping) return;
      let f: Record<string, unknown> & { type?: unknown; id?: string };
      try {
        f = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof f?.type !== "string") return;
      // Session selection is a host operation. Fork is a deliberate RPC transition to a new file.
      if (SESSION_SELECTION[f.type]) {
        socket.handlers.onFrame(cid, JSON.stringify({ type: "response", command: f.type, id: f.id, success: false, error: "Use /api/children to open a session" }));
        return;
      }
      if (f.bridgeSnapshot && (f.type === "get_entries" || f.type === "get_messages")) socket.snapshotId = f.id;
      delete f.bridgeSnapshot;
      if (f.type === "extension_ui_response" && f.id) child.dialogs.delete(f.id);
      if (f.type === "prompt") {
        f.id ??= `prompt-${crypto.randomUUID()}`;
        child.admission.add(f.id);
      }
      try {
        write(child, f);
      } catch {
        /* the child already exited */
      }
    },

    close(cid) {
      const socket = sockets.get(cid);
      if (!socket) return;
      sockets.delete(cid);
      if (socket.child.sockets.delete(cid) && socket.child.sockets.size === 0) socket.child.idleSince = Date.now();
    },

    async shutdown() {
      if (exiting) return;
      exiting = true;
      clearInterval(reaper);
      const processes = [...children.values()];
      for (const child of processes) stop(child);
      const timer = setTimeout(() => {
        for (const child of processes) if (child.proc.exitCode === null) child.proc.kill("SIGKILL");
      }, 1500);
      await Promise.all(processes.map((c) => c.proc.exited));
      clearTimeout(timer);
    },
  };
}
