// Workspace list and session catalogue of the web dev bridge. Ported from ompweb-desktop bridge/server.ts
// (remembered(), readSession(), sessions(), complete(), POST /api/workspace) with async file access.
import fs from "node:fs/promises";
import path from "node:path";

/** One session file: `id` and `title` come from its head, `updatedAt` is the file mtime in ms. */
export interface SessionRow { path: string; id: string; title: string; updatedAt: number }

export interface Workspace { cwd: string; sessions: SessionRow[] }
export interface Sessions { workspaces: Workspace[] }
/** `exists`: the typed path is itself a directory. `entries`: absolute directory paths completing it. */
export interface Completion { exists: boolean; entries: string[] }

export interface StoreOptions {
  agentDir: string;
  /** Shown as a workspace even when nothing is remembered or used yet; "" for none. */
  defaultCwd: string;
  /** Default: `<agentDir>/cgs/web-workspaces.json`. */
  workspacesFile?: string;
  /** Default: `<agentDir>/sessions`. */
  sessionsDir?: string;
}

export interface Store {
  sessions(): Promise<Sessions>;
  /** Creates the directory (recursively) and remembers it as a possibly empty workspace. */
  remember(cwd: string): Promise<void>;
  complete(typed: string): Promise<Completion>;
  title(file: string): Promise<string | undefined>;
}

const HEAD_BYTES = 256 * 1024;
const PREVIEW_CHARS = 80;
const COMPLETION_LIMIT = 40;

interface Entry {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
  title?: unknown;
  message?: { role?: unknown; content?: unknown } | null;
}
interface Part { type?: unknown; text?: unknown }
interface Head { id: string; cwd: string; title: string; first: string }

/** Writes to one workspaces file run one at a time, so a read-modify-write never drops a concurrent remember(). */
const queues = new Map<string, Promise<void>>();
function exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/** The remembered workspace directories; a missing, unreadable or malformed file reads as none. */
async function remembered(file: string): Promise<string[]> {
  try {
    const list: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Same scheme as agent-config.ts writeAtomic: temp file beside the target, then rename; keeps the file's mode. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = (await fs.stat(file)).mode & 0o777; } catch { /* new file */ }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const handle = await fs.open(tmp, "w", mode);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function readHead(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseEntry(line: string): Entry | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === "object" ? (v as Entry) : undefined;
  } catch {
    return undefined;
  }
}

/** A user message's text: a plain string, or the `text` parts of a content array joined by spaces. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p: Part | null) => (p?.type === "text" ? p.text : "")).join(" ");
}

/** Title line, session header (id and cwd) and first user message of a session file's head. */
function parseHead(head: string): Head {
  let title = "", id = "", cwd = "", first = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    const e = parseEntry(line);
    if (!e) continue;
    if (e.type === "title" && typeof e.title === "string") title = e.title.trim();
    else if (e.type === "session") { id = String(e.id ?? ""); cwd = String(e.cwd ?? ""); }
    else if (e.type === "message" && e.message?.role === "user" && !first) {
      first = messageText(e.message.content).replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
    }
    if (title && first && cwd) break;
  }
  return { id, cwd, title, first };
}

/** The head of a session file is enough. Undefined for a file that was never used (no cwd, or no title and no user message). */
async function readSession(file: string): Promise<{ cwd: string; row: SessionRow } | undefined> {
  const { id, cwd, title, first } = parseHead(await readHead(file));
  if (!cwd || (!title && !first)) return undefined;
  const { mtimeMs } = await fs.stat(file);
  return { cwd, row: { path: file, id, title: title || first, updatedAt: mtimeMs } };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export function createStore(opts: StoreOptions): Store {
  const defaultCwd = opts.defaultCwd ? path.resolve(opts.defaultCwd) : "";
  const workspacesFile = opts.workspacesFile ?? path.join(opts.agentDir, "cgs", "web-workspaces.json");
  const lockKey = path.resolve(workspacesFile);
  const sessionsDir = opts.sessionsDir ?? path.join(opts.agentDir, "sessions");

  return {
    async sessions(): Promise<Sessions> {
      const byCwd = new Map<string, SessionRow[]>();
      for (const known of await remembered(workspacesFile)) byCwd.set(known, []);
      if (defaultCwd && !byCwd.has(defaultCwd)) byCwd.set(defaultCwd, []);
      const dirs = (await fs.access(sessionsDir).then(() => true, () => false)) ? await fs.readdir(sessionsDir) : [];
      for (const dir of dirs) {
        try {
          for (const name of await fs.readdir(path.join(sessionsDir, dir))) {
            if (!name.endsWith(".jsonl") || name.startsWith(".")) continue;
            try {
              const s = await readSession(path.join(sessionsDir, dir, name));
              if (!s) continue;
              const rows = byCwd.get(s.cwd) ?? [];
              rows.push(s.row);
              byCwd.set(s.cwd, rows);
            } catch (e) {
              if ((e as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw e;
            }
          }
        } catch (e) {
          if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException | undefined)?.code ?? "")) throw e;
        }
      }
      const workspaces = [...byCwd].map(([cwd, rows]) => {
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        return { cwd, sessions: rows, newest: rows.reduce((m, r) => Math.max(m, r.updatedAt), 0) };
      });
      workspaces.sort((a, b) => b.newest - a.newest || a.cwd.localeCompare(b.cwd));
      return { workspaces: workspaces.map(({ cwd, sessions }) => ({ cwd, sessions })) };
    },

    async remember(cwd: string): Promise<void> {
      if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
      const dir = path.resolve(cwd);
      await fs.mkdir(dir, { recursive: true });
      await exclusive(lockKey, async () => {
        const list = await remembered(workspacesFile);
        if (list.includes(dir)) return;
        await writeAtomic(workspacesFile, `${JSON.stringify([...list, dir], null, 2)}\n`);
      });
    },

    /** Directory suggestions for a path being typed: the directories under its parent that start with its last segment (hidden ones only when asked for). */
    async complete(typed: string): Promise<Completion> {
      if (!path.isAbsolute(typed)) return { exists: false, entries: [] };
      const inDir = typed.endsWith("/");
      const dir = inDir ? typed : path.dirname(typed);
      const prefix = inDir ? "" : path.basename(typed).toLowerCase();
      const names = await fs.readdir(dir).catch((): string[] => []);
      const candidates = names
        .filter((n) => n.toLowerCase().startsWith(prefix) && (prefix.startsWith(".") || !n.startsWith(".")))
        .sort((a, b) => a.localeCompare(b));
      const entries: string[] = [];
      for (const n of candidates) {
        if (entries.length === COMPLETION_LIMIT) break;
        const p = path.join(dir, n);
        if (await isDir(p)) entries.push(p);
      }
      return { exists: await isDir(typed), entries };
    },

    async title(file: string): Promise<string | undefined> {
      try {
        return (await readSession(file))?.row.title;
      } catch {
        return undefined;
      }
    },
  };
}
