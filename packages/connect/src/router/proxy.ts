// Outbound proxy selection (ADR 0029). Same order as omp's provider fetches, minus the per-provider form: PI_PROXY first, then
// HTTPS_PROXY for https/wss or HTTP_PROXY for http/ws, then ALL_PROXY; NO_PROXY opts hosts out (loopback always connects directly).
// Bun's fetch would pick the variables up by itself, but WebSocket and tls.connect do not, so every request path asks here
// and passes the result explicitly.

const first = (env: NodeJS.ProcessEnv, ...names: string[]): string | undefined => {
  for (const n of names) { const v = env[n]?.trim(); if (v) return v; }
  return undefined;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True when NO_PROXY names `url`'s host: `*`, an exact host, a domain suffix (`example.com` or `.example.com`), optionally with a port. */
function bypassed(url: URL, list: string): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  for (const raw of list.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const m = /^(.*?)(?::(\d+))?$/.exec(entry);
    const name = (m?.[1] ?? entry).replace(/^\*?\./, "");
    if (m?.[2] && m[2] !== port) continue;
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

/** The proxy URL to use for `url`, or undefined to connect directly. Only http(s) proxies are supported. */
export function proxyFor(url: URL, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (LOOPBACK.has(url.hostname)) return undefined;
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const raw = first(env, "PI_PROXY") ?? (secure ? first(env, "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy") : first(env, "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"));
  if (!raw) return undefined;
  const noProxy = first(env, "NO_PROXY", "no_proxy");
  if (noProxy && bypassed(url, noProxy)) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return /^https?:\/\//i.test(withScheme) ? withScheme : undefined;
}
