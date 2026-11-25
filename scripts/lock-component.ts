#!/usr/bin/env bun
// Usage: bun scripts/lock-component.ts --id chromium --version 150.0.7871.24 --platform linux-x64 \
//          --url https://… [--url https://mirror…] [--bin name=rel/path] [--path-dir rel/dir] [--license id]
// Downloads the first reachable URL, computes size and SHA256, and upserts the entry in components.lock.
// The hash is never typed by hand: this is the only way entries are created.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseComponentsLock, PLATFORMS, type ComponentEntry, type Platform } from "../packages/connect/src/components/lock.ts";

function opts(argv: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument near "${k}"`);
    m.set(k.slice(2), [...(m.get(k.slice(2)) ?? []), argv[i + 1]!]);
  }
  return m;
}

export async function hashUrl(url: string): Promise<{ sha256: string; size: number }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`);
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of res.body) { h.update(chunk); size += chunk.length; }
  return { sha256: h.digest("hex"), size };
}

if (import.meta.main) {
  const o = opts(process.argv.slice(2));
  const one = (k: string) => { const v = o.get(k); if (!v || v.length !== 1) throw new Error(`--${k} is required exactly once`); return v[0]!; };
  const platform = one("platform") as Platform;
  if (!PLATFORMS.includes(platform)) throw new Error(`--platform must be one of ${PLATFORMS.join(", ")}`);
  const urls = o.get("url") ?? [];
  if (urls.length === 0) throw new Error("--url is required");

  let measured: { sha256: string; size: number } | null = null;
  for (const u of urls) { try { measured = await hashUrl(u); break; } catch (e) { console.error(String(e)); } }
  if (!measured) throw new Error("no URL could be downloaded");

  const bin = Object.fromEntries((o.get("bin") ?? []).map((b) => { const [k, ...v] = b.split("="); return [k!, v.join("=")]; }));
  const entry: ComponentEntry = {
    id: one("id"), version: one("version"), platform, url: urls, sha256: measured.sha256, size: measured.size,
    ...(o.has("license") ? { license: one("license") } : {}),
    ...(Object.keys(bin).length ? { bin } : {}),
    ...(o.has("path-dir") ? { pathDirs: o.get("path-dir")! } : {}),
  };
  const file = path.resolve(import.meta.dir, "../components.lock");
  const lock = parseComponentsLock(fs.readFileSync(file, "utf8"));
  const next = { components: [...lock.components.filter((c) => !(c.id === entry.id && c.platform === entry.platform)), entry] };
  parseComponentsLock(JSON.stringify(next)); // validate before writing
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${entry.id} ${entry.version} ${platform}: sha256 ${entry.sha256} (${entry.size} bytes)`);
}
