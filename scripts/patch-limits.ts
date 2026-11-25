#!/usr/bin/env bun
// Usage: bun scripts/patch-limits.ts   — limits come from patches/limits.json; null means the owner has not decided (O4).
import fs from "node:fs";
import path from "node:path";
import { checkPatchLimits, patchFiles, type PatchLimits } from "./lib.ts";

const root = path.resolve(import.meta.dir, "..");
const limits: PatchLimits = JSON.parse(fs.readFileSync(path.join(root, "patches/limits.json"), "utf8"));
const r = checkPatchLimits(patchFiles(path.join(root, "patches")), limits);
console.log(`${r.patches} patch(es), ${r.files} file(s)`);
if (r.undecided.length) console.log(`limits not decided yet (O4), not enforced: ${r.undecided.join(", ")}`);
if (r.violations.length) { console.error(r.violations.join("\n")); process.exit(1); }
