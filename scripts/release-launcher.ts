#!/usr/bin/env bun
import path from "node:path";
import { resolveAgentDir, seedDistributionDefaults } from "../packages/connect/src/agent-config.ts";
import { CONFIG_DIR_NAME, daemonDir } from "../packages/connect/src/profile.ts";

const root = path.resolve(import.meta.dir, "..");
process.env.PI_CONFIG_DIR ||= CONFIG_DIR_NAME;
// cgs's daemon lives in cgs's own directory under its own names (P18); an omp daemon on the same machine is never met.
process.env.CGS_DAEMON_DIR ||= daemonDir();
seedDistributionDefaults(resolveAgentDir(), path.join(root, "plugin/omp-extension/index.ts"));

// omp's executable entry installs process handlers and is also its own worker host.
// Keep it the main module, without interposing a process on Unix (tty, signals, exit status).
const args = [process.execPath, path.join(root, "dist/cli.js"), ...process.argv.slice(2)];
const execve = (process as typeof process & { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
if (process.platform !== "win32" && execve) execve(args[0]!, args, process.env);
const child = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
