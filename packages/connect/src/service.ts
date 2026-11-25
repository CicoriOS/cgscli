import { createProviderHub, type ProviderHubImpl } from "./providers/index.ts";
import { createRouter, CONTROL_PREFIX, type RouterImpl, type RouterOptions } from "./router/index.ts";

export interface ConnectService {
  router: RouterImpl;
  hub: ProviderHubImpl;
  /** Serves requests addressed to CGSCONNECT_ORIGIN (manifest, slots, provider traffic, router control) by direct call: no socket, no IPC. */
  fetch(req: Request): Promise<Response>;
  stop(): void;
}

/** cgsconnect as a library inside the omp process: provider traffic leaves through the router (direct first, relay tunnel on failure). */
export function createConnect(o: RouterOptions): ConnectService {
  const router = createRouter(o);
  const hub = createProviderHub({ router });
  return {
    router,
    hub,
    async fetch(req) {
      if (new URL(req.url).pathname.startsWith(CONTROL_PREFIX)) return (await router.handleControl(req)) ?? new Response("not found", { status: 404 });
      return hub.fetch(req);
    },
    stop: () => router.stop(),
  };
}
