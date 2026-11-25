#!/usr/bin/env bun
// Usage: bun scripts/fetch-omp.ts [dir]   (default .build/omp) — fetch the omp commit pinned in omp.lock.json
import fs from "node:fs";
import path from "node:path";
import { fetchOmp, parseOmpLock } from "./lib.ts";

const root = path.resolve(import.meta.dir, "..");
const dir = path.resolve(process.argv[2] ?? path.join(root, ".build/omp"));
const lock = parseOmpLock(fs.readFileSync(path.join(root, "omp.lock.json"), "utf8"));
fetchOmp(lock, dir);
console.log(`omp ${lock.tag ?? lock.commit.slice(0, 10)} (${lock.commit}) ready in ${dir}`);
