// Build-time defaults baked into this repository. A fork changes them here; nothing else in the code names a server.
// Candidate order is the fallback order (ADR 0015); Bootstrap probes all of them and takes the fastest healthy one.
export const DEFAULT_CANDIDATES: readonly string[] = [
  "https://ai.cicori.com",
  "https://apia.bmpss.top",
  "https://ai.cnklp.cn",
];

/** CGS_BASE_URL replaces the whole list: a test server must never fall back to production. */
export function candidatesFrom(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.CGS_BASE_URL?.trim();
  return override ? [override.replace(/\/+$/, "")] : [...DEFAULT_CANDIDATES];
}

/** The origin stored with the credential: the first default (or the override), never a Bootstrap-selected mirror. */
export const logicalOrigin = (env: NodeJS.ProcessEnv = process.env): string => candidatesFrom(env)[0]!;

/** Cloudflare preferred-IP fallback (ADR 0015): on unless CGS_CLOUDFLARE=0. It only acts when no candidate answers on the normal route. */
export const cloudflareFrom = (env: NodeJS.ProcessEnv = process.env): { enabled: boolean } => ({ enabled: env.CGS_CLOUDFLARE?.trim() !== "0" });
