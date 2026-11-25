// Resumable, verified downloader (logic from the legacy scripts/fetch-upstream.mjs: Range resume, stall detection,
// retries). The URL list is abstract so mirrors can be added without code changes (ADR 0007).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DownloadOptions {
  urls: string[];
  dest: string;
  sha256: string;
  attempts?: number;
  stallMs?: number;
  fetch?: typeof fetch;
  onProgress?(have: number, total: number | null): void;
}

export class HashMismatch extends Error {}

function sha256File(file: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const h = createHash("sha256");
  fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  return promise;
}
export { sha256File };

async function attempt(url: string, part: string, o: Required<Pick<DownloadOptions, "stallMs">> & DownloadOptions) {
  const f = o.fetch ?? fetch;
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), o.stallMs);
  try {
    const res = await f(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow", signal: ctl.signal });
    if (!res.ok) throw Object.assign(new Error(`GET ${url} -> ${res.status}`), { fatal: res.status >= 400 && res.status < 500 && res.status !== 429 });
    let start = have;
    if (have && res.status !== 206) { fs.rmSync(part, { force: true }); start = 0; } // server ignored Range: restart
    const lenHeader = res.headers.get("content-length");
    const total = lenHeader !== null && Number.isFinite(Number(lenHeader)) ? start + Number(lenHeader) : null;
    const out = fs.createWriteStream(part, { flags: start === 0 ? "w" : "a" });
    let got = start;
    try {
      for await (const chunk of res.body!) {
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", r));
        got += chunk.length;
        o.onProgress?.(got, total);
        clearTimeout(timer);
        timer = setTimeout(() => ctl.abort(), o.stallMs);
      }
    } finally {
      // Flush even on failure: the partial file is what the next attempt resumes from.
      await new Promise<void>((r) => out.end(r));
    }
    if (total !== null && got < total) throw new Error(`short body ${got}/${total}`);
  } finally { clearTimeout(timer); }
}

/** Downloads to `dest` (atomic rename after SHA256 verification). Tries each URL in order, resuming partial data. */
export async function download(o: DownloadOptions): Promise<void> {
  const part = `${o.dest}.part`;
  fs.mkdirSync(path.dirname(o.dest), { recursive: true });
  const attempts = o.attempts ?? 5;
  let last: unknown = new Error("no url");
  for (const url of o.urls) {
    for (let i = 0; i < attempts; i++) {
      try {
        await attempt(url, part, { ...o, stallMs: o.stallMs ?? 20_000 });
        const actual = await sha256File(part);
        if (actual !== o.sha256) { fs.rmSync(part, { force: true }); throw new HashMismatch(`SHA256 mismatch for ${url}: expected ${o.sha256}, got ${actual}`); }
        fs.renameSync(part, o.dest);
        return;
      } catch (e) {
        last = e;
        if (e instanceof HashMismatch) break; // this source is bad: next URL
        if ((e as { fatal?: boolean }).fatal) break;
      }
    }
  }
  throw last;
}
