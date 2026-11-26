// Bootstrap: pick the API origin among candidates (ADR 0015, ADR 0029). Every candidate is probed at once with the same test
// as the direct-reachability check (HEALTH_PATH, status < 300, origin marker header), so an error page a CDN made up does not
// count. The list order is the priority: the winner is the first healthy candidate in it. A healthy candidate is final once
// nothing ahead of it is still pending; otherwise Bootstrap waits for the better ones, but only `patienceMs` after the first
// candidate passed, so a slow high-priority route cannot stall start-up for the whole probe timeout.
import { HEALTH_PATH, ORIGIN_HEADER } from "./tunnel.ts";

export interface BootstrapOptions {
  direct: (req: Request) => Promise<Response>;
  timeoutMs?: number;
  /** How long a better-ranked candidate may still answer once a lower-ranked one has passed. */
  patienceMs?: number;
  log?: (msg: string) => void;
}

/** The highest-priority healthy candidate, or null when none answers. */
export function bootstrap(candidates: readonly URL[], o: BootstrapOptions): Promise<URL | null> {
  const log = o.log ?? (() => {});
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(o.timeoutMs ?? 5000)]);
  const state: ("pending" | "ok" | "failed")[] = candidates.map(() => "pending");
  const { promise, resolve } = Promise.withResolvers<URL | null>();
  let patience: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const done = (win: URL | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(patience);
    stop.abort();
    resolve(win);
  };
  const decide = () => {
    const best = state.indexOf("ok");
    if (best >= 0 && !state.slice(0, best).includes("pending")) done(candidates[best]!);
    else if (!state.includes("pending")) done(null);
  };
  candidates.forEach((c, i) => {
    void (async () => {
      const r = await o.direct(new Request(new URL(HEALTH_PATH, c), { signal }));
      await r.arrayBuffer();
      if (r.status >= 300 || !r.headers.get(ORIGIN_HEADER)) throw new Error(`${c.host}: HTTP ${r.status}${r.headers.get(ORIGIN_HEADER) ? "" : " without origin marker"}`);
    })().then(
      () => {
        state[i] = "ok";
        patience ??= setTimeout(() => done(candidates[state.indexOf("ok")]!), o.patienceMs ?? 3000);
        decide();
      },
      (e) => {
        state[i] = "failed";
        if (!stop.signal.aborted) log(`candidate failed: ${e instanceof Error ? e.message : e}`);
        decide();
      },
    );
  });
  return promise;
}
