#!/usr/bin/env bun
// Usage: bun scripts/replay-patches.ts [ompDir]   — validate patch headers, then `git am --3way` the series.
// Exits non-zero (CI failure) on a missing header or a conflict, printing the conflicting files.
import path from "node:path";
import { patchFiles, patchHeaderErrors, replayPatches } from "./lib.ts";

const root = path.resolve(import.meta.dir, "..");
const ompDir = path.resolve(process.argv[2] ?? path.join(root, ".build/omp"));
const patches = patchFiles(path.join(root, "patches"));

const header = patches.flatMap(patchHeaderErrors);
if (header.length) { console.error(header.join("\n")); process.exit(1); }

const r = replayPatches(ompDir, patches);
if (!r.ok) { console.error(`patch replay failed:\n${r.log}\nconflicts:\n${r.conflicts.map((c) => `  ${c}`).join("\n")}`); process.exit(1); }
console.log(`applied ${r.applied} patch(es) onto ${ompDir}`);
