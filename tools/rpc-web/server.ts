/**
 * Development bridge: one headless omp in RPC mode behind a web page (static files, a WebSocket of raw JSONL frames, a small HTTP API).
 * Not the cgsconnect remote (ADR 0025/0026 put that in omp's daemon behind a relay); it lets the UI and the RPC surface be worked on.
 *
 * Usage: bun tools/rpc-web/server.ts [-- command args...]     default command: cgs --mode rpc-ui
 * Env:   PORT (8787), HOST (127.0.0.1), WORKDIR (the first omp's cwd, default process.cwd()),
 *        AGENT_DIR (where omp keeps sessions/, default $PI_CODING_AGENT_DIR or ~/.cgs/agent)
 * Anyone who can reach the port controls the agent: keep HOST on loopback unless the network is trusted.
 *
 * HTTP API (JSON):
 *   GET  /api/info                -> { cwd, agentDir }
 *   GET  /api/sessions            -> { workspaces: [{ cwd, sessions: [{ path, id, title, updatedAt }] }] }   newest first; updatedAt in ms
 *   POST /api/workspace {cwd}     -> { cwd }          creates the directory and remembers it as a (possibly empty) workspace
 *   POST /api/cwd {cwd}           -> { cwd, restarted }   makes the omp child run in cwd, restarting it when it runs elsewhere;
 *                                   restarting aborts its running turn, clears the frame backlog and sends {"type":"bridge_restart","cwd"} to pages
 * WebSocket /ws: frames from omp's stdout (one JSON object per message) out, one JSON RPC command per message in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dir;
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};
const cut = process.argv.indexOf("--");
const command = cut >= 0 && process.argv.length > cut + 1 ? process.argv.slice(cut + 1) : ["cgs", "--mode", "rpc-ui"];
const agentDir = process.env.AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".cgs", "agent");
const workspacesFile = path.join(agentDir, "cgs", "web-workspaces.json");
/** Frames kept for pages that connect late or reload. */
const BACKLOG = 5000;

let log: string[] = [];
const clients = new Set<Bun.ServerWebSocket<unknown>>();
let cwd = path.resolve(process.env.WORKDIR ?? process.cwd());
let generation = 0;
let child: Bun.Subprocess<"pipe", "pipe", "inherit">;

function publish(line: string): void {
  log.push(line);
  if (log.length > BACKLOG) log.splice(0, log.length - BACKLOG);
  for (const ws of clients) ws.send(line);
}

function spawn(): void {
  const mine = ++generation;
  fs.mkdirSync(cwd, { recursive: true });
  const proc = Bun.spawn(command, { cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  child = proc;
  void (async () => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stdout) {
      if (mine !== generation) return;
      rest += decoder.decode(chunk, { stream: true });
      for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
        const line = rest.slice(0, i);
        rest = rest.slice(i + 1);
        if (line.trim()) publish(line);
      }
    }
    const exitCode = await proc.exited;
    if (mine === generation) publish(JSON.stringify({ type: "bridge_exit", exitCode }));
  })();
}

async function setCwd(next: string): Promise<boolean> {
  const target = path.resolve(next);
  if (target === cwd && child.exitCode === null) return false;
  generation++;
  const old = child;
  old.kill();
  await old.exited;
  cwd = target;
  log = [];
  spawn();
  publish(JSON.stringify({ type: "bridge_restart", cwd }));
  return true;
}

function remembered(): string[] {
  try {
    const list: unknown = JSON.parse(fs.readFileSync(workspacesFile, "utf8"));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface SessionRow { path: string; id: string; title: string; updatedAt: number }

/** The head of a session file is enough: a padded title line, the header with cwd and id, then the first user message. */
function readSession(file: string): { cwd: string; row: SessionRow } | undefined {
  const fd = fs.openSync(file, "r");
  let head: string;
  try {
    const buf = Buffer.alloc(256 * 1024);
    head = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally {
    fs.closeSync(fd);
  }
  let title = "", id = "", sessionCwd = "", first = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "title" && typeof e.title === "string") title = e.title.trim();
    else if (e.type === "session") { id = String(e.id ?? ""); sessionCwd = String(e.cwd ?? ""); }
    else if (e.type === "message" && e.message?.role === "user" && !first) {
      const c = e.message.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (p?.type === "text" ? p.text : "")).join(" ") : "";
      first = text.replace(/\s+/g, " ").trim().slice(0, 80);
    }
    if (title && first && sessionCwd) break;
  }
  if (!sessionCwd || (!title && !first)) return undefined; // never used
  return { cwd: sessionCwd, row: { path: file, id, title: title || first, updatedAt: fs.statSync(file).mtimeMs } };
}

function sessions(): { workspaces: { cwd: string; sessions: SessionRow[] }[] } {
  const byCwd: Record<string, SessionRow[]> = {};
  for (const known of remembered()) byCwd[known] = [];
  const root = path.join(agentDir, "sessions");
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!name.endsWith(".jsonl") || name.startsWith(".")) continue;
      const s = readSession(path.join(root, dir, name));
      if (s) (byCwd[s.cwd] ??= []).push(s.row);
    }
  }
  const newest = (rows: SessionRow[]) => rows.reduce((m, r) => Math.max(m, r.updatedAt), 0);
  return {
    workspaces: Object.entries(byCwd)
      .map(([c, rows]) => ({ cwd: c, sessions: rows.sort((a, b) => b.updatedAt - a.updatedAt) }))
      .sort((a, b) => newest(b.sessions) - newest(a.sessions) || a.cwd.localeCompare(b.cwd)),
  };
}

/** Directory suggestions for a path being typed: the directories under its parent that start with its last segment (hidden ones only when asked for). */
function complete(typed: string): { exists: boolean; entries: string[] } {
  if (!path.isAbsolute(typed)) return { exists: false, entries: [] };
  const inDir = typed.endsWith("/");
  const dir = inDir ? typed : path.dirname(typed);
  const prefix = inDir ? "" : path.basename(typed).toLowerCase();
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch {}
  const entries = names
    .filter((n) => n.toLowerCase().startsWith(prefix) && (prefix.startsWith(".") || !n.startsWith(".")) && isDir(path.join(dir, n)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 40)
    .map((n) => path.join(dir, n));
  return { exists: isDir(typed), entries };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function api(req: Request, route: string): Promise<Response> {
  if (route === "/api/info" && req.method === "GET") return json({ cwd, agentDir });
  if (route === "/api/sessions" && req.method === "GET") return json(sessions());
  if (route === "/api/complete" && req.method === "GET") return json(complete(new URL(req.url).searchParams.get("path") ?? "/"));
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  const body = (await req.json().catch(() => null)) as { cwd?: unknown } | null;
  if (typeof body?.cwd !== "string" || !path.isAbsolute(body.cwd)) return json({ error: "cwd must be an absolute path" }, 400);
  if (route === "/api/workspace") {
    fs.mkdirSync(body.cwd, { recursive: true });
    const list = remembered();
    if (!list.includes(body.cwd)) {
      fs.mkdirSync(path.dirname(workspacesFile), { recursive: true });
      fs.writeFileSync(workspacesFile, `${JSON.stringify([...list, body.cwd], null, 2)}\n`);
    }
    return json({ cwd: body.cwd });
  }
  if (route === "/api/cwd") return json({ cwd: path.resolve(body.cwd), restarted: await setCwd(body.cwd) });
  return json({ error: "not found" }, 404);
}

spawn();
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  async fetch(req, srv) {
    const route = new URL(req.url).pathname;
    if (route === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    if (route.startsWith("/api/")) return api(req, route);
    if (route === "/mermaid.min.js") { // optional: mermaid's browser bundle (MERMAID_JS); without it diagrams stay as source
      const file = Bun.file(process.env.MERMAID_JS ?? "");
      return process.env.MERMAID_JS && (await file.exists()) ? new Response(file, { headers: { "content-type": "text/javascript; charset=utf-8" } }) : new Response("not found", { status: 404 });
    }
    const asset = STATIC[route];
    if (!asset) return new Response("not found", { status: 404 });
    return new Response(Bun.file(path.join(here, asset[0])), { headers: { "content-type": asset[1], "cache-control": "no-store" } });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      for (const line of log) ws.send(line);
    },
    close(ws) {
      clients.delete(ws);
    },
    message(_ws, message) {
      const line = String(message).trim();
      if (!line) return;
      child.stdin.write(`${line.replaceAll("\n", " ")}\n`);
      child.stdin.flush();
    },
  },
});

console.log(`rpc-web: http://${server.hostname}:${server.port}  ->  ${command.join(" ")}  (cwd ${cwd})`);
process.on("SIGTERM", () => process.exit(0));
