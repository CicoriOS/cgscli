import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createProviderHub, type ProviderHubImpl } from "./providers/index.ts";
import { createRouter, CONTROL_PREFIX, type RouterImpl, type RouterOptions } from "./router/index.ts";

/** The machine's `device_id` secret: generated once, readable by its owner only. Without a data directory it lives as long as the process. */
function deviceSeed(dir: string | undefined): string {
  if (!dir) return randomBytes(32).toString("hex");
  const file = path.join(dir, "device-seed");
  try {
    const seed = fs.readFileSync(file, "utf8").trim();
    if (seed) return seed;
  } catch { /* first run */ }
  const seed = randomBytes(32).toString("hex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${seed}\n`, { mode: 0o600 });
  return seed;
}

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
  const hub = createProviderHub({ router, deviceSeed: deviceSeed(o.dataDir) });
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
