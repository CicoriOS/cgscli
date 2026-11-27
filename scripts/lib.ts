// Shared logic for the sync/patch scripts (docs: cgsconnect/omp-sync.md, patches.md, branching.md).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface OmpLock {
  repo: string;
  /** Release tag, or null for an untagged snapshot of the default branch. */
  tag: string | null;
  commit: string;
  /** Nearest released tag when `tag` is null (information only). */
  baseTag?: string;
  /** Official release assets: platform -> { name, sha256 } (only needed if the official binary route is used, V5). */
  assets?: Record<string, { name: string; sha256: string }>;
  chromium?: string;
  syncedAt: string;
}

export function parseOmpLock(text: string): OmpLock {
  const j: unknown = JSON.parse(text);
  const o = j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  if (typeof o.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error("omp.lock.json: invalid repo");
  if (o.tag !== null && typeof o.tag !== "string") throw new Error("omp.lock.json: tag must be a string or null");
  if (typeof o.commit !== "string" || !/^[0-9a-f]{40}$/.test(o.commit)) throw new Error("omp.lock.json: commit must be a 40-char sha");
  if (typeof o.syncedAt !== "string" || Number.isNaN(Date.parse(o.syncedAt))) throw new Error("omp.lock.json: syncedAt must be an ISO date");
  return o as unknown as OmpLock;
}

export function git(cwd: string, args: string[], input?: string) {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Fetch exactly the locked commit into `dir` (shallow) and verify HEAD. */
export function fetchOmp(lock: OmpLock, dir: string, remote = `https://github.com/${lock.repo}.git`): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) git(dir, ["init", "-q"]);
  const f = git(dir, ["fetch", "--depth", "1", remote, lock.commit]);
  if (!f.ok) throw new Error(`git fetch ${lock.commit} failed: ${f.out}`);
  const c = git(dir, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
  if (!c.ok) throw new Error(`git checkout failed: ${c.out}`);
  const head = git(dir, ["rev-parse", "HEAD"]).out;
  if (head !== lock.commit) throw new Error(`checked-out ${head} does not match omp.lock.json ${lock.commit}`);
}

export const patchFiles = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".patch")).sort().map((f) => path.join(dir, f)) : [];

const REQUIRED_HEADERS = ["Reason:", "Upstream:", "Remove-when:"];

/** patches.md admission: each patch states why, its upstream status and when it can be dropped. */
export function patchHeaderErrors(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const header = text.split(/^---$/m)[0] ?? "";
  return REQUIRED_HEADERS.filter((h) => !new RegExp(`^${h}\\s*\\S`, "m").test(header)).map((h) => `${path.basename(file)}: missing "${h}" in the commit message`);
}

export interface ReplayResult { ok: boolean; applied: number; log: string; conflicts: string[] }

/** `git am --3way` the series onto the checkout; on failure aborts and lists conflicting files. */
export function replayPatches(ompDir: string, patches: string[]): ReplayResult {
  if (patches.length === 0) return { ok: true, applied: 0, log: "no patches", conflicts: [] };
  const identity = ["-c", "user.name=cgscli", "-c", "user.email=cgscli@localhost"];
  const r = git(ompDir, [...identity, "am", "--3way", ...patches]);
  if (r.ok) return { ok: true, applied: patches.length, log: r.out, conflicts: [] };
  const conflicts = git(ompDir, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
  // `am --abort` fails with "Committer identity unknown" on a runner without a global identity, leaving the tree half-applied.
  git(ompDir, [...identity, "am", "--abort"]);
  return { ok: false, applied: 0, log: r.out, conflicts };
}

export interface PatchLimits {
  /** null = the limit is an undecided owner decision (O4); reported, not enforced. */
  maxPatches: number | null;
  maxFiles: number | null;
}

export interface LimitReport { patches: number; files: number; violations: string[]; undecided: string[] }

export function checkPatchLimits(patches: string[], limits: PatchLimits): LimitReport {
  const files = new Set<string>();
  for (const p of patches) for (const m of fs.readFileSync(p, "utf8").matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) files.add(m[1]!);
  const violations: string[] = [], undecided: string[] = [];
  if (limits.maxPatches === null) undecided.push("maxPatches"); else if (patches.length > limits.maxPatches) violations.push(`${patches.length} patches > limit ${limits.maxPatches}`);
  if (limits.maxFiles === null) undecided.push("maxFiles"); else if (files.size > limits.maxFiles) violations.push(`${files.size} files > limit ${limits.maxFiles}`);
  return { patches: patches.length, files: files.size, violations, undecided };
}

export const SYNC_INTERVAL_DAYS = 45;

/** omp-sync.md: roughly every 45 days. */
export function syncAge(lock: OmpLock, now = Date.now()): { days: number; due: boolean } {
  const days = Math.floor((now - Date.parse(lock.syncedAt)) / 86_400_000);
  return { days, due: days >= SYNC_INTERVAL_DAYS };
}
