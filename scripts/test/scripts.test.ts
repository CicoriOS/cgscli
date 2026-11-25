import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPatchLimits, fetchOmp, git, parseOmpLock, patchFiles, patchHeaderErrors, replayPatches, syncAge } from "../lib.ts";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-scripts-")); dirs.push(d); return d; };
import { afterAll } from "bun:test";
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const ident = ["-c", "user.name=t", "-c", "user.email=t@t"];
function repo(files: Record<string, string>): string {
  const d = tmp();
  git(d, ["init", "-q", "-b", "main"]);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  git(d, ["add", "."]);
  git(d, [...ident, "commit", "-q", "-m", "base"]);
  return d;
}
const head = (d: string) => git(d, ["rev-parse", "HEAD"]).out;

/** Makes a patch file (format-patch) from changing `file` to `content` in a scratch clone of `from`. */
function makePatch(from: string, file: string, content: string, message: string): string {
  const work = tmp();
  git(work, ["clone", "-q", from, "."]);
  fs.writeFileSync(path.join(work, file), content);
  git(work, [...ident, "commit", "-qam", message]);
  const out = tmp();
  git(work, ["format-patch", "-1", "-o", out]);
  return path.join(out, fs.readdirSync(out)[0]!);
}

test("omp.lock.json validation", () => {
  const ok = { repo: "can1357/oh-my-pi", tag: null, commit: "a".repeat(40), syncedAt: "2026-11-25" };
  expect(parseOmpLock(JSON.stringify(ok)).tag).toBeNull();
  expect(() => parseOmpLock(JSON.stringify({ ...ok, commit: "abc" }))).toThrow("commit");
  expect(() => parseOmpLock(JSON.stringify({ ...ok, syncedAt: "soon" }))).toThrow("syncedAt");
});

test("fetchOmp checks out exactly the locked commit", () => {
  const upstream = repo({ a: "1\n" });
  const c1 = head(upstream);
  fs.writeFileSync(path.join(upstream, "a"), "2\n");
  git(upstream, [...ident, "commit", "-qam", "second"]);
  git(upstream, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const dest = tmp();
  fetchOmp({ repo: "x/y", tag: null, commit: c1, syncedAt: "2026-11-25" }, dest, upstream);
  expect(head(dest)).toBe(c1);
  expect(fs.readFileSync(path.join(dest, "a"), "utf8")).toBe("1\n");
  expect(() => fetchOmp({ repo: "x/y", tag: null, commit: "f".repeat(40), syncedAt: "2026-11-25" }, tmp(), upstream)).toThrow();
});

test("replay applies a series with 3-way merge and reports conflicts without leaving a half-applied tree", () => {
  const base = repo({ f: "line1\nline2\nline3\n" });
  const good = makePatch(base, "f", "line1\nline2 changed\nline3\n", "tweak\n\nReason: r\nUpstream: none\nRemove-when: never");
  const checkout = tmp();
  git(checkout, ["clone", "-q", base, "."]);
  const r = replayPatches(checkout, [good]);
  expect(r).toMatchObject({ ok: true, applied: 1 });
  expect(fs.readFileSync(path.join(checkout, "f"), "utf8")).toContain("line2 changed");

  // Upstream moved on to a conflicting edit of the same line: replay must fail and abort cleanly.
  const moved = tmp();
  git(moved, ["clone", "-q", base, "."]);
  fs.writeFileSync(path.join(moved, "f"), "line1\nline2 upstream\nline3\n");
  git(moved, [...ident, "commit", "-qam", "upstream"]);
  const bad = replayPatches(moved, [good]);
  expect(bad.ok).toBe(false);
  expect(bad.conflicts).toEqual(["f"]);
  expect(git(moved, ["status", "--porcelain"]).out).toBe("");
});

test("patch headers must state Reason, Upstream and Remove-when", () => {
  const base = repo({ f: "x\n" });
  const full = makePatch(base, "f", "y\n", "msg\n\nReason: needed\nUpstream: https://example/pr/1\nRemove-when: PR merged");
  const partial = makePatch(base, "f", "z\n", "msg\n\nReason: needed");
  expect(patchHeaderErrors(full)).toEqual([]);
  expect(patchHeaderErrors(partial).map((e) => e.replace(/^.*: /, ""))).toEqual(['missing "Upstream:" in the commit message', 'missing "Remove-when:" in the commit message']);
});

test("limits: undecided (null) limits are reported, decided ones enforced", () => {
  const base = repo({ a: "1\n", b: "1\n" });
  const dir = tmp();
  const p1 = makePatch(base, "a", "2\n", "one");
  const p2 = makePatch(base, "b", "2\n", "two");
  fs.copyFileSync(p1, path.join(dir, "0001-a.patch"));
  fs.copyFileSync(p2, path.join(dir, "0002-b.patch"));
  const files = patchFiles(dir);
  expect(checkPatchLimits(files, { maxPatches: null, maxFiles: null })).toMatchObject({ patches: 2, files: 2, violations: [], undecided: ["maxPatches", "maxFiles"] });
  expect(checkPatchLimits(files, { maxPatches: 1, maxFiles: 5 }).violations).toEqual(["2 patches > limit 1"]);
});

test("sync is due after 45 days", () => {
  const lock = { repo: "a/b", tag: null, commit: "a".repeat(40), syncedAt: "2026-01-01" };
  expect(syncAge(lock, Date.parse("2026-02-14"))).toEqual({ days: 44, due: false });
  expect(syncAge(lock, Date.parse("2026-02-15"))).toEqual({ days: 45, due: true });
});
