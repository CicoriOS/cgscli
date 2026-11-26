// Build-time defaults baked into this repository. A fork changes them here; nothing else in the code names a server.
// Candidate order is the priority (ADR 0029): Bootstrap probes all of them and takes the first healthy one in this order,
// waiting a few seconds for better-ranked ones. The Cloudflare-fronted host leads because it is the route we want by default.
export const DEFAULT_CANDIDATES: readonly string[] = [
  "https://apia.bmpss.top",
  "https://ai.cicori.com",
  "https://ai.cnklp.cn",
];

/** The server's own name: what a credential records as its origin, whichever candidate carried the login. */
const LOGICAL_ORIGIN = "https://ai.cicori.com";

/** CGS_BASE_URL replaces the whole list: a test server must never fall back to production. */
export function candidatesFrom(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.CGS_BASE_URL?.trim();
  return override ? [override.replace(/\/+$/, "")] : [...DEFAULT_CANDIDATES];
}

/** The origin stored with the credential: the server's own name (or the override), never a Bootstrap-selected mirror. */
export const logicalOrigin = (env: NodeJS.ProcessEnv = process.env): string => (env.CGS_BASE_URL?.trim() ? candidatesFrom(env)[0]! : LOGICAL_ORIGIN);

/** Cloudflare preferred-IP fallback (ADR 0015): on unless CGS_CLOUDFLARE=0. It only acts when no candidate answers on the normal route. */
export const cloudflareFrom = (env: NodeJS.ProcessEnv = process.env): { enabled: boolean } => ({ enabled: env.CGS_CLOUDFLARE?.trim() !== "0" });
