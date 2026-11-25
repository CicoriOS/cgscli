// components.lock: pinned third-party components (docs: cgsconnect/components.md; format is a proposal there).
// Additions over the documented fields: `bin` (executable name -> path inside the archive) and `pathDirs`
// (archive-relative dirs prepended to PATH of the omp process only), because the document leaves the layout to V7/V10.
export type Platform = "win-x64" | "linux-x64";
export const PLATFORMS: readonly Platform[] = ["win-x64", "linux-x64"];

export interface ComponentEntry {
  id: string;
  version: string;
  platform: Platform;
  url: string[];
  sha256: string;
  size: number;
  license?: string;
  bin?: Record<string, string>;
  pathDirs?: string[];
}
export interface ComponentsLock { components: ComponentEntry[] }

const SHA = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]*$/;

function fail(i: number, msg: string): never { throw new Error(`components.lock[${i}]: ${msg}`); }

export function parseComponentsLock(text: string): ComponentsLock {
  const j: unknown = JSON.parse(text);
  const list = j && typeof j === "object" ? (j as { components?: unknown }).components : undefined;
  if (!Array.isArray(list)) throw new Error("components.lock: missing components array");
  const seen = new Set<string>();
  const out: ComponentEntry[] = list.map((raw: unknown, i) => {
    const e = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : fail(i, "not an object");
    if (typeof e.id !== "string" || !ID.test(e.id)) fail(i, "invalid id");
    if (typeof e.version !== "string" || !e.version) fail(i, "missing version");
    if (!PLATFORMS.includes(e.platform as Platform)) fail(i, `platform must be one of ${PLATFORMS.join(", ")}`);
    if (!Array.isArray(e.url) || e.url.length === 0 || !e.url.every((u) => typeof u === "string" && /^https:\/\//.test(u))) fail(i, "url must be a non-empty list of https URLs");
    if (typeof e.sha256 !== "string" || !SHA.test(e.sha256)) fail(i, "sha256 must be 64 lowercase hex chars");
    if (!Number.isInteger(e.size) || (e.size as number) < 0) fail(i, "size must be a non-negative integer");
    const key = `${e.id}/${e.platform}`;
    if (seen.has(key)) fail(i, `duplicate ${key}`);
    seen.add(key);
    for (const rel of [...Object.values((e.bin as Record<string, string>) ?? {}), ...((e.pathDirs as string[]) ?? [])]) {
      if (typeof rel !== "string" || rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) fail(i, `unsafe path "${rel}"`);
    }
    return e as unknown as ComponentEntry;
  });
  return { components: out };
}

export const forPlatform = (lock: ComponentsLock, p: Platform): ComponentEntry[] => lock.components.filter((c) => c.platform === p);
