#!/usr/bin/env bun
// Usage: bun scripts/update-check.ts [--remote]
// Reports how long ago omp was last synced (target: about every 45 days); --remote also lists newer upstream tags.
import fs from "node:fs";
import path from "node:path";
import { git, parseOmpLock, syncAge } from "./lib.ts";

const root = path.resolve(import.meta.dir, "..");
const lock = parseOmpLock(fs.readFileSync(path.join(root, "omp.lock.json"), "utf8"));
const age = syncAge(lock);
console.log(`omp ${lock.tag ?? `${lock.baseTag ?? "untagged"}+${lock.commit.slice(0, 7)}`} synced ${age.days} day(s) ago${age.due ? " — sync is due (see docs omp-sync)" : ""}`);

if (process.argv.includes("--remote")) {
  const r = git(root, ["ls-remote", "--tags", "--refs", `https://github.com/${lock.repo}.git`]);
  if (!r.ok) { console.error(`ls-remote failed: ${r.out}`); process.exit(1); }
  const tags = r.out.split("\n").map((l) => l.split("refs/tags/")[1]).filter((t): t is string => !!t && /^v\d+\.\d+\.\d+$/.test(t));
  const ver = (t: string) => t.slice(1).split(".").map(Number);
  const newer = (a: string, b: string) => { const [x, y] = [ver(a), ver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!; return false; };
  const base = lock.tag ?? lock.baseTag;
  const later = base ? tags.filter((t) => newer(t, base)).sort((a, b) => (newer(a, b) ? 1 : -1)) : [];
  console.log(later.length ? `${later.length} newer tag(s): ${later.slice(-5).join(", ")}${later.length > 5 ? ", …" : ""}` : "no newer upstream tags");
}
