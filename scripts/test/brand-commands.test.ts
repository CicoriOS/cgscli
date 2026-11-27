import { expect, test } from "bun:test";
import { brandCommandHints } from "../brand-commands.ts";

test("inline code, usage lines and help examples name cgs", () => {
  expect(brandCommandHints("Run `omp --resume` without an argument to pick from recent sessions, or `omp` to start a new one."))
    .toBe("Run `cgs --resume` without an argument to pick from recent sessions, or `cgs` to start a new one.");
  expect(brandCommandHints('"Run \\`omp update\\` to upgrade"')).toBe('"Run \\`cgs update\\` to upgrade"');
  expect(brandCommandHints('throw new CliUsageError("usage: omp skill search <query>");')).toBe('throw new CliUsageError("usage: cgs skill search <query>");');
  expect(brandCommandHints('static examples = ["omp ps --all", \'omp say "hi"\'];')).toBe('static examples = ["cgs ps --all", \'cgs say "hi"\'];');
  expect(brandCommandHints('"No plugins installed. Install one with omp plugin install <package>."')).toBe('"No plugins installed. Install one with cgs plugin install <package>."');
  expect(brandCommandHints('"omp skill version minor && omp skill publish"')).toBe('"cgs skill version minor && cgs skill publish"');
});

test("the product name in a sentence stays", () => {
  for (const line of [
    'logger.debug("omp daemon unreachable; using in-process image URL backends");',
    'description: "omp starts it on this machine"',
    'description: "omp browser native messaging host"',
    "summary: `omp wants to run ${event.toolName}`,",
    "`omp had lost its connection to this tab's page`",
    'lead: "omp connects once to see whether the server needs credentials."',
    "How does omp reach it?",
  ]) expect(brandCommandHints(line)).toBe(line);
});

test("URLs, environment variables, config paths and comments stay", () => {
  for (const line of [
    'const target = "omp://docs/rpc.md";',
    'const dir = "~/.omp/agent/sessions";',
    "if (process.env.OMP_DAEMON_DIR) return OMP_DAEMON_DIR;",
    "// Run `omp update` to upgrade",
    "   * `omp ps` lists the units",
    "/** The `omp collab link` JSON shape */",
  ]) expect(brandCommandHints(line)).toBe(line);
});

test("markdown prompts and tips rewrite inline code only", () => {
  const md = "Databases appear in `omp ps`; run omp ps stop to save.\nTry `omp -c` to resume.";
  expect(brandCommandHints(md, true)).toBe("Databases appear in `cgs ps`; run omp ps stop to save.\nTry `cgs -c` to resume.");
});
