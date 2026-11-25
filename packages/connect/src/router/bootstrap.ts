// Bootstrap: pick the API origin among candidates (ADR 0015). Every candidate is probed at once with the same test as
// the direct-reachability check (HEALTH_PATH, status < 300, origin marker header), so an error page a CDN made up
// does not count. The first candidate to pass wins; the others are aborted.
import { HEALTH_PATH, ORIGIN_HEADER } from "./tunnel.ts";

export interface BootstrapOptions {
  direct: (req: Request) => Promise<Response>;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** The fastest healthy candidate, or null when none answers. */
export async function bootstrap(candidates: readonly URL[], o: BootstrapOptions): Promise<URL | null> {
  const log = o.log ?? (() => {});
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(o.timeoutMs ?? 5000)]);
  const probe = async (c: URL): Promise<URL> => {
    const r = await o.direct(new Request(new URL(HEALTH_PATH, c), { signal }));
    await r.arrayBuffer();
    if (r.status >= 300 || !r.headers.get(ORIGIN_HEADER)) throw new Error(`${c.host}: HTTP ${r.status}${r.headers.get(ORIGIN_HEADER) ? "" : " without origin marker"}`);
    return c;
  };
  try {
    return await Promise.any(candidates.map((c) => probe(c).catch((e) => { if (!stop.signal.aborted) log(`candidate failed: ${e instanceof Error ? e.message : e}`); throw e; })));
  } catch { return null; } finally { stop.abort(); }
}
