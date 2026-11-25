import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ComponentManager, DoctorReport } from "../contracts.ts";
import { download } from "./download.ts";
import { forPlatform, type ComponentEntry, type ComponentsLock, type Platform } from "./lock.ts";

export interface ComponentManagerOptions {
  lock: ComponentsLock;
  /** Install root; components live in <root>/<id>/<version>/ with an install.json marker. */
  root: string;
  platform?: Platform;
  fetch?: typeof fetch;
}

export interface ComponentManagerImpl extends ComponentManager {
  /** Download, verify and extract one component (no-op when the pinned version is installed). */
  install(id: string, onProgress?: (have: number, total: number | null) => void): Promise<void>;
}

interface Marker { id: string; version: string; sha256: string }

export function currentPlatform(): Platform {
  if (process.arch !== "x64") throw new Error(`unsupported architecture ${process.arch}`);
  if (process.platform === "win32") return "win-x64";
  if (process.platform === "linux") return "linux-x64";
  throw new Error(`unsupported platform ${process.platform}`);
}

function extract(archive: string, dir: string, url: string) {
  const isZip = /\.zip(\?|$)/i.test(url);
  // bsdtar (Windows, macOS) reads zip; GNU tar does not, so Linux zips go through unzip.
  const r = isZip && process.platform === "linux" ? spawnSync("unzip", ["-q", "-o", archive, "-d", dir]) : spawnSync("tar", ["-xf", archive, "-C", dir]);
  if (r.status !== 0) throw new Error(`extracting ${path.basename(archive)} failed: ${r.stderr?.toString().trim() || r.error?.message}`);
}

export function createComponentManager(o: ComponentManagerOptions): ComponentManagerImpl {
  const platform = o.platform ?? currentPlatform();
  const entries = forPlatform(o.lock, platform);
  const dirOf = (e: ComponentEntry) => path.join(o.root, e.id, e.version);
  const marker = (e: ComponentEntry): Marker | null => {
    try { return JSON.parse(fs.readFileSync(path.join(dirOf(e), "install.json"), "utf8")); } catch { return null; }
  };
  const installed = (e: ComponentEntry) => marker(e)?.sha256 === e.sha256;

  return {
    async install(id, onProgress) {
      const e = entries.find((x) => x.id === id);
      if (!e) throw new Error(`component "${id}" is not in components.lock for ${platform}`);
      if (installed(e)) return;
      const dir = dirOf(e);
      const archive = path.join(o.root, ".downloads", `${e.id}-${e.version}-${e.sha256.slice(0, 12)}`);
      await download({ urls: e.url, dest: archive, sha256: e.sha256, fetch: o.fetch, onProgress });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      extract(archive, dir, e.url[0]!);
      fs.writeFileSync(path.join(dir, "install.json"), JSON.stringify({ id: e.id, version: e.version, sha256: e.sha256 } satisfies Marker));
      fs.rmSync(archive, { force: true });
    },

    async resolve(name) {
      for (const e of entries) {
        const rel = e.bin?.[name];
        if (!rel || !installed(e)) continue;
        const p = path.join(dirOf(e), rel);
        if (fs.existsSync(p)) return p;
      }
      return null;
    },

    envPath: () => entries.filter(installed).flatMap((e) => (e.pathDirs ?? []).map((d) => path.join(dirOf(e), d))),

    async doctor(): Promise<DoctorReport> {
      const items: DoctorReport["items"] = [];
      for (const e of entries) {
        const m = marker(e);
        if (!m) { items.push({ name: e.id, status: "missing", detail: `run: cgscli update (pinned ${e.version})` }); continue; }
        if (m.sha256 !== e.sha256) { items.push({ name: e.id, status: "mismatch", detail: `installed ${m.version}, components.lock pins ${e.version}; run: cgscli update` }); continue; }
        const absent = Object.entries(e.bin ?? {}).filter(([, rel]) => !fs.existsSync(path.join(dirOf(e), rel))).map(([n]) => n);
        if (absent.length) { items.push({ name: e.id, status: "mismatch", detail: `missing executables: ${absent.join(", ")}` }); continue; }
        items.push({ name: e.id, status: "ok", detail: e.version });
        if (e.id === "chromium" && platform === "linux-x64") items.push(chromiumRuntime(dirOf(e), e.bin?.chromium));
      }
      return { ok: items.every((i) => i.status === "ok"), items };
    },
  };
}

/** [待验证 V10] Linux Chromium needs shared libraries and, as root or in restricted containers, --no-sandbox. */
function chromiumRuntime(dir: string, rel: string | undefined): DoctorReport["items"][number] {
  if (!rel) return { name: "chromium-runtime", status: "unsupported", detail: "components.lock has no bin.chromium" };
  const r = spawnSync("ldd", [path.join(dir, rel)]);
  if (r.error) return { name: "chromium-runtime", status: "unsupported", detail: "ldd not available; cannot check shared libraries" };
  const missing = r.stdout.toString().split("\n").filter((l) => l.includes("not found")).map((l) => l.trim().split(" ")[0]);
  if (missing.length) return { name: "chromium-runtime", status: "missing", detail: `missing libraries: ${missing.join(", ")} (e.g. apt install libnss3 libgbm1 fonts-noto-cjk)` };
  if (process.getuid?.() === 0) return { name: "chromium-runtime", status: "mismatch", detail: "running as root: Chromium needs --no-sandbox" };
  return { name: "chromium-runtime", status: "ok" };
}
