#!/usr/bin/env bun
// Usage: bun scripts/smoke-release.ts TARBALL
// Installs the release tarball the way a user does (`bun install -g`) into a scratch dir and runs the real `cgs` against a
// local fake CGS server: omp's extension loader, not Bun alone, decides how the vendored libraries load, so this is the
// only check that catches a package that works in the repo and fails when installed.
// Covers: the extension loads, the layout fetch and the config.yml rewrite (agent-config + vendored yaml) work.
// Exits non-zero with the child's output on any failure.
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tarball = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!tarball || !(await Bun.file(tarball).exists())) throw new Error("usage: smoke-release.ts TARBALL");

const TIMEOUT_MS = 90_000;
const home = await mkdtemp(path.join(os.tmpdir(), "cgs-smoke-"));
const bunInstall = path.join(home, "bun");
const agentDir = path.join(home, ".cgs/agent");
const log: string[] = [];
let child: Bun.Subprocess | undefined;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    log.push(`fake server: ${req.method} ${pathname}`);
    const headers = { "x-cgs-origin": "1", "content-type": "application/json" };
    if (pathname === "/api/device/layout") {
      return Response.json({ success: true, data: { orchestrator: { model: "cgs-openai/echo", thinking: "high" }, agents: [{ name: "task", model: "cgs-openai/echo" }], web_model: "" } }, { headers });
    }
    if (pathname === "/_cgsconnect/manifest") return Response.json([], { headers });
    return Response.json({ success: true, data: {} }, { headers });
  },
});

async function run(command: string[], env: Record<string, string>) {
  const proc = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${out}\n${err}`);
  return out;
}

try {
  const env = { ...process.env, HOME: home, BUN_INSTALL: bunInstall, PI_CONFIG_DIR: ".cgs", CGS_BASE_URL: `http://127.0.0.1:${server.port}` } as Record<string, string>;
  delete env.PI_CODING_AGENT_DIR;
  env.PATH = `${path.join(bunInstall, "bin")}:${process.env.PATH}`;
  await run([process.execPath, "install", "-g", tarball], env);
  const cgs = path.join(bunInstall, "bin/cgs");
  const version = (await run([cgs, "--version"], env)).trim();
  if (!/^omp\/\d+\.\d+\.\d+-cgs\.\d+$/.test(version)) throw new Error(`unexpected version: ${version}`);

  await mkdir(path.join(agentDir, "cgs"), { recursive: true });
  await writeFile(path.join(agentDir, "models.yml"), "providers:\n  fake:\n    baseUrl: http://127.0.0.1:9/v1\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: echo\n        name: Echo\n        contextWindow: 32000\n        maxTokens: 4096\n");
  await writeFile(path.join(agentDir, "cgs/credentials.json"), JSON.stringify({ baseUrl: env.CGS_BASE_URL, clientSecret: "smoke", username: "smoke", tier: "free", models: [], pricing: {} }), { mode: 0o600 });

  const messages = Promise.withResolvers<string>();
  child = Bun.spawn([cgs, "--mode", "rpc-ui", "--model", "fake/echo"], { env, cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        log.push(`rpc: ${line.slice(0, 300)}`);
        const frame = (() => { try { return JSON.parse(line) as { type?: string; method?: string; message?: string }; } catch { return undefined; } })();
        if (frame?.type === "extension_ui_request" && frame.method === "notify" && frame.message) messages.resolve(frame.message);
        else if (/not a function|Failed to load extension/i.test(line)) messages.resolve(line.slice(0, 300));
      }
    }
  })();
  child.stdin!.write(`${JSON.stringify({ id: "1", type: "prompt", message: "/agents layout sync" })}\n`);
  child.stdin!.flush();
  const message = await Promise.race([
    messages.promise,
    Bun.sleep(TIMEOUT_MS).then(() => { throw new Error(`no answer to /agents layout sync within ${TIMEOUT_MS / 1000}s`); }),
  ]);
  if (/not a function|Cannot find module|Failed to load/i.test(message)) throw new Error(`/agents layout sync failed: ${message}`);

  const config = await readFile(path.join(agentDir, "config.yml"), "utf8");
  if (!config.includes("cgs-openai/echo")) throw new Error(`/agents layout sync answered "${message}" but config.yml has no layout:\n${config}`);
  console.log(`smoke ok: ${version}; /agents layout sync wrote the cloud layout (${message})`);
} catch (error) {
  console.error(`smoke FAILED: ${error instanceof Error ? error.message : String(error)}\n--- log\n${log.slice(-40).join("\n")}`);
  process.exitCode = 1;
} finally {
  child?.kill();
  server.stop(true);
  await rm(home, { recursive: true, force: true });
}
