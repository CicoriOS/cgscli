/**
 * Development bridge: one headless omp in RPC mode, shown in a web page as raw JSONL frames.
 * Not the cgsconnect remote (ADR 0025/0026 put that in omp's daemon behind a relay); this only lets the RPC surface be looked at.
 *
 * Usage: bun tools/rpc-web/server.ts [-- command args...]     default command: cgs --mode rpc-ui
 * Env:   PORT (8787), HOST (127.0.0.1)
 * Anyone who can reach the port controls the agent: keep HOST on loopback unless the network is trusted.
 */
import path from "node:path";

const html = Bun.file(path.join(import.meta.dir, "index.html"));
const cut = process.argv.indexOf("--");
const command = cut >= 0 && process.argv.length > cut + 1 ? process.argv.slice(cut + 1) : ["cgs", "--mode", "rpc-ui"];
/** Frames kept for pages that connect late or reload. */
const BACKLOG = 5000;

const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const log: string[] = [];
const clients = new Set<Bun.ServerWebSocket<unknown>>();

function publish(line: string): void {
  log.push(line);
  if (log.length > BACKLOG) log.splice(0, log.length - BACKLOG);
  for (const ws of clients) ws.send(line);
}

void (async () => {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of child.stdout) {
    rest += decoder.decode(chunk, { stream: true });
    for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (line.trim()) publish(line);
    }
  }
  publish(JSON.stringify({ type: "bridge_exit", exitCode: await child.exited }));
})();

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
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

console.log(`rpc-web: http://${server.hostname}:${server.port}  ->  ${command.join(" ")}`);
process.on("SIGTERM", () => process.exit(0));
