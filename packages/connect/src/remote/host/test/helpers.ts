import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost, type Host, type HostOptions } from "../index.ts";

export type Frame = Record<string, any>;

/** The ChildStatus fields the host returns from GET /api/children and POST /api/children. */
export interface ChildStatus {
  id: string;
  cwd: string;
  sessionPath?: string;
  title?: string;
  updatedAt: number;
  ring: "idle" | "work" | "think";
  level: string;
  unseen: boolean;
}

export const FAKE_OMP = path.join(import.meta.dir, "fixtures", "fake-omp.ts");
export const DEVICE = "test-device";
const WS_PATH = "/ws";

/** One temp root per test: the agent dir, workspaces and session files. teardown() removes it. */
export interface Sandbox {
  root: string;
  agentDir: string;
  /** A directory under the sandbox, usable as a workspace. */
  workspace(name: string): string;
  /** Writes a file under the agent dir; returns its absolute path. */
  write(rel: string, text: string): string;
  /** A session file under agentDir/sessions/<dir>/ whose mtime is `mtimeSec`, so ordering is deterministic. */
  session(dir: string, name: string, lines: unknown[], mtimeSec: number): string;
}

export function sandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-test-")));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  const write = (rel: string, text: string): string => {
    const file = path.join(agentDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return {
    root,
    agentDir,
    workspace(name) {
      const dir = path.join(root, "ws", name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    write,
    session(dir, name, lines, mtimeSec) {
      const file = write(path.join("sessions", dir, name), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      fs.utimesSync(file, mtimeSec, mtimeSec);
      return file;
    },
  };
}

export const header = (id: string, cwd: string) => ({ type: "session", id, cwd });
export const titleLine = (title: string) => ({ type: "title", title });
export const userLine = (content: unknown) => ({ type: "message", message: { role: "user", content } });

const live = new Set<Host>();

/** A host over the fake child, with every timer long enough not to fire unless a test sets it. */
export function makeHost(sb: Sandbox, overrides: Partial<HostOptions> = {}): Host {
  const host = createHost({
    agentDir: sb.agentDir,
    device: DEVICE,
    command: [process.execPath, FAKE_OMP],
    rpcTimeoutMs: 5_000,
    idleMs: 60_000,
    attachGraceMs: 5_000,
    reapIntervalMs: 60_000,
    childLimit: 8,
    titleChecksMs: [],
    ...overrides,
  });
  live.add(host);
  return host;
}

export async function retire(host: Host): Promise<void> {
  live.delete(host);
  await host.shutdown();
}

/** Shuts down every host the test made and removes the sandbox. */
export async function teardown(sb: Sandbox): Promise<void> {
  for (const host of [...live]) await retire(host);
  fs.rmSync(sb.root, { recursive: true, force: true });
}

export const get = (host: Host, p: string) => host.request({ method: "GET", path: p });
export const post = (host: Host, p: string, body?: unknown) => host.request({ method: "POST", path: p, body });
export const openChild = (host: Host, cwd: string, sessionPath?: string) => post(host, "/api/children", { cwd, sessionPath });

function isChild(value: unknown): value is ChildStatus {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}

/** Narrows one child status from a response body. Throws when the body is not a child status. */
export function childOf(body: unknown): ChildStatus {
  if (!isChild(body)) throw new Error(`not a child status: ${JSON.stringify(body)}`);
  return body;
}

/** The statuses listed by GET /api/children, in the order the host returned them. */
export async function listChildren(host: Host): Promise<ChildStatus[]> {
  const res = await get(host, "/api/children");
  const body: unknown = res.body;
  if (typeof body !== "object" || body === null || !("children" in body) || !Array.isArray(body.children)) {
    throw new Error(`not a children body: ${JSON.stringify(body)}`);
  }
  const children: unknown[] = body.children;
  if (!children.every(isChild)) throw new Error(`bad child in children body: ${JSON.stringify(children)}`);
  return children;
}

/** The ids listed by GET /api/children. */
export async function childIds(host: Host): Promise<string[]> {
  return (await listChildren(host)).map((child) => child.id);
}

/** One socket as the page sees it. `frames` keeps the raw text the host delivered. */
export interface Link {
  frames: string[];
  state: "connecting" | "open" | "closed";
  reason?: string;
}

export function attach(host: Host, cid: string): Link {
  const link: Link = { frames: [], state: "connecting" };
  host.open(cid, WS_PATH, {
    onOpen: () => {
      link.state = "open";
    },
    onFrame: (_cid: string, text: string) => {
      link.frames.push(text);
    },
    onClose: (_cid: string, reason: string) => {
      link.state = "closed";
      link.reason = reason;
    },
  });
  return link;
}

function isFrame(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The delivered frames that parse as a JSON object. Lines that do not parse are skipped. */
export function frames(link: Link): Frame[] {
  return link.frames.flatMap((text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return isFrame(parsed) ? [parsed] : [];
  });
}

export function sendFrame(host: Host, cid: string, frame: Record<string, unknown>): void {
  host.frame(cid, JSON.stringify(frame));
}

export async function reply(link: Link, id: string): Promise<Frame> {
  await until(() => frames(link).some((f) => f.type === "response" && f.id === id), `response ${id}`);
  const found = frames(link).find((f) => f.type === "response" && f.id === id);
  if (!found) throw new Error(`response ${id} vanished`);
  return found;
}

/** Sends one command with an id and waits for its response. */
export async function call(host: Host, cid: string, link: Link, frame: { type: string; id?: string; [key: string]: unknown }): Promise<Frame> {
  const id = frame.id ?? `t-${crypto.randomUUID()}`;
  sendFrame(host, cid, { ...frame, id });
  return reply(link, id);
}

/** Polls `check` until it holds. Every wait in the suite goes through here, with one deadline. */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
