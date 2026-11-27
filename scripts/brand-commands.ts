#!/usr/bin/env bun
// Usage: bun scripts/brand-commands.ts [ompDir] [--check]
//
// Rewrites the command name in omp's user-facing command hints (the text a user can copy and run) from `omp` to `cgs`.
// It is how patch P17 is made, and how a conflict in P17 is resolved after an omp sync: restore the file from upstream and
// run this script instead of merging by hand. `--check` changes nothing and exits 1 when a hint would still change.
//
// Only command hints are rewritten. `omp` as the name of the product in a sentence ("the omp daemon did not answer")
// stays, and so do `omp://` URLs, `OMP_*` variables, `.omp` paths and comments.
import fs from "node:fs";
import path from "node:path";

/** Subcommands omp has. A word that also reads as prose after "omp" ("omp process", "omp daemon") is not one of them. */
const COMMANDS = [
  "anonymize", "auth", "auth-broker", "auth-gateway", "bench", "browser", "browser-relay", "cleanse", "clip", "collab", "compress",
  "config", "discover", "disable", "dry-balance", "enable", "extensions", "gallery", "gc", "git", "grievances", "if-bench", "images",
  "install", "launch", "list", "marketplace", "models", "play", "plugin", "predict", "ps", "read", "remove", "render", "say", "session",
  "setup", "skill", "ssh", "stats", "stream", "tiny-models", "toks", "ttsr", "uninstall", "update", "upgrade", "usage", "worktree",
];
/** A string that opens with the command is a help example only when its second word is one of these: "omp browser native messaging host" is a description. */
const EXAMPLE_COMMANDS = COMMANDS.filter((c) => c !== "browser" && c !== "gc");

const alternatives = (words: string[]) => words.join("|");
const FLAG = "--?[a-z]";

const RULES: { name: string; pattern: RegExp }[] = [
  // Inline code: `omp`, `omp ps --all`, and the escaped form inside a template literal \`omp update\`. A template literal that
  // merely starts with "omp" ("`omp wants to run ...`") is not inline code: its second word is not a command.
  {
    name: "backticked",
    pattern: new RegExp(`(\\\\?\`)omp(?=\\\\?\`| (?:${alternatives(COMMANDS)})\\b[^\`\\n]*?\\\\?\`| ${FLAG}[^\`\\n]*?\\\\?\`)`, "g"),
  },
  // usage: omp skill add <name>
  { name: "usage", pattern: /\b([Uu]sage: )omp(?= )/g },
  // "omp ps --all" opening a quoted string (a help example)
  { name: "example", pattern: new RegExp(`(["'\`])omp(?= (?:${alternatives(EXAMPLE_COMMANDS)})\\b| ${FLAG})`, "g") },
  // Install one with omp plugin install <package> / Install npm plugins:        omp plugin install <package> / a && omp skill publish
  { name: "instruction", pattern: new RegExp(`(: +|&& |\\b[Ww]ith |\\b[Rr]un |\\b[Uu]se )omp(?= (?:${alternatives(COMMANDS)})\\b| ${FLAG})`, "g") },
];

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/** `omp` -> `cgs` in the command hints of one source file. Lines that are only a comment are left alone. */
export function brandCommandHints(text: string, markdown = false): string {
  const rules = markdown ? RULES.filter((r) => r.name === "backticked") : RULES;
  return text
    .split("\n")
    .map((line) => (!markdown && COMMENT_LINE.test(line) ? line : rules.reduce((l, r) => l.replace(r.pattern, "$1cgs"), line)))
    .join("\n");
}

const SOURCE = /\.(ts|tsx)$/;
const PROSE = /\.(md|txt)$/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "test" || entry.name === "__tests__") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(file);
    else if ((SOURCE.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) || (PROSE.test(entry.name) && !/(^|\/)(CHANGELOG|README)/i.test(file))) yield file;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const ompDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(import.meta.dir, "../.build/omp"));
  const changed: string[] = [];
  for (const pkg of fs.readdirSync(path.join(ompDir, "packages"))) {
    const src = path.join(ompDir, "packages", pkg, "src");
    if (!fs.existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const before = fs.readFileSync(file, "utf8");
      const after = brandCommandHints(before, PROSE.test(file));
      if (after === before) continue;
      changed.push(path.relative(ompDir, file));
      if (!check) fs.writeFileSync(file, after);
    }
  }
  console.log(`${check ? "would change" : "changed"} ${changed.length} file(s)`);
  if (check && changed.length) {
    console.log(changed.map((f) => `  ${f}`).join("\n"));
    process.exit(1);
  }
}
