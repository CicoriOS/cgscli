import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ANTIGRAVITY_KEY_ENV, applyCredentialEnv, fetchModelIds, fetchPricing, readAccount, SECRET_ENV, writeAccount } from "./account.ts";
import { deviceLogin } from "./login.ts";
import { applyDefaultLayout, CGSCONNECT_ORIGIN, CHANNELS, createComponentManager, createConnect, currentPlatform, parseComponentsLock, resolveAgentDir, type ComponentManagerImpl, type ProviderHubImpl } from "@cgscli/connect";
import { candidatesFrom, cloudflareFrom, logicalOrigin } from "./defaults.ts";
import { registerRemoteCommands } from "./remote.ts";
// omp extension: registers the CGS channels from the manifest of cgsconnect, which runs inside the omp process as a
// library (ADR 0014): provider traffic is handed to its router by direct call, so our providers leave through the
// cgsconnect router (direct first, relay tunnel on failure) and nothing listens on a port. Loaded with
// `omp -e <this file>` (profile.ts); replaces the legacy plugin/omp-cgs. No credentials polling: credentials arrive through `oauth`.
//
// Source: ProviderConfig / oauth shapes read from can1357/oh-my-pi @76b7d84
// (packages/coding-agent/src/extensibility/extensions/types.ts). With `oauth` registered, a stored login credential
// takes precedence over `apiKey` (docs/extensions.md), which is what lets omp rotate between sibling slots.

interface ManifestModel {
  id: string; name: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean;
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
interface ManifestProvider { id: string; channel: string; baseUrl: string; models: ManifestModel[] }
interface OAuthCredentials { refresh: string; access: string; expires: number }

interface CommandContext { ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }
interface ExtensionApi {
  registerProvider(name: string, config: Record<string, unknown>): void;
  unregisterProvider?(name: string): void;
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: CommandContext): Promise<void> }): void;
}

function lockPath(): string { return process.env.CGS_COMPONENTS_LOCK ?? path.resolve(import.meta.dir, "../../components.lock"); }

function componentManager(): ComponentManagerImpl {
  const home = process.env.CGSCLI_HOME?.trim() || path.join(os.homedir(), ".cgs");
  return createComponentManager({ lock: parseComponentsLock(fs.readFileSync(lockPath(), "utf8")), root: path.join(home, "components"), platform: currentPlatform() });
}

/** `/cgs-doctor` and `/cgs-update`: component checks and installs (components.md) as slash commands, not a separate CLI. */
export function registerComponentCommands(pi: ExtensionApi): void {
  pi.registerCommand("cgs-doctor", {
    description: "Check bundled components (Chromium, toolchain, Git) and their runtime dependencies",
    handler: async (_a, ctx) => {
      const r = await componentManager().doctor();
      ctx.ui.notify(r.items.length ? r.items.map((i) => `${i.status.padEnd(8)} ${i.name}${i.detail ? `  ${i.detail}` : ""}`).join("\n") : "components.lock has no entries for this platform", r.ok ? "info" : "warning");
    },
  });
  pi.registerCommand("cgs-update", {
    description: "Install the components pinned in components.lock",
    handler: async (_a, ctx) => {
      const m = componentManager();
      const platform = currentPlatform();
      for (const e of parseComponentsLock(fs.readFileSync(lockPath(), "utf8")).components.filter((c) => c.platform === platform)) {
        ctx.ui.notify(`Installing ${e.id} ${e.version}…`, "info");
        await m.install(e.id);
      }
      ctx.ui.notify("Components up to date", "info");
    },
  });
}

const API: Record<string, string> = {
  "cgs-claude": "anthropic-messages",
  "cgs-antigravity": "google-gemini-cli",
  "cgs-codex": "openai-codex-responses",
  "cgs-openai": "openai-completions",
};
const LONG_LIVED_MS = 365 * 24 * 3600 * 1000;

async function getJson(via: FetchFn, url: string): Promise<unknown> {
  const r = await via(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`cgsconnect ${new URL(url).pathname}: HTTP ${r.status}`);
  return r.json();
}

function asManifest(v: unknown): ManifestProvider[] {
  const o = v && typeof v === "object" ? (v as { providers?: unknown }) : {};
  if (!Array.isArray(o.providers)) throw new Error("cgsconnect manifest malformed");
  return o.providers as ManifestProvider[];
}

/** The gateway slot currently preferred for `provider`; omp stores it as the login credential. */
async function slotCredential(via: FetchFn, provider: string): Promise<OAuthCredentials> {
  const s = (await getJson(via, `${CGSCONNECT_ORIGIN}/_cgsconnect/slot?provider=${encodeURIComponent(provider)}`)) as { id?: unknown; key?: unknown };
  if (typeof s.id !== "string" || typeof s.key !== "string") throw new Error("cgsconnect slot malformed");
  return { refresh: s.id, access: s.key, expires: Date.now() + LONG_LIVED_MS };
}

interface LoginCallbacks {
  onAuth(info: { url: string; instructions?: string }): void;
  onPrompt(p: { message: string }): Promise<string>;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}
interface CgsCredentials extends OAuthCredentials { enterpriseUrl?: string; email?: string }

/** The part of cgsconnect login needs: the Bootstrap-selected origin and a fetch that leaves through the router. */
export interface LoginRoute { ready(): Promise<void>; upstream(): string; fetch(req: Request): Promise<Response> }

/**
 * `/login` -> Cicori Good Service: device flow (page approval + polling) through the router. No server prompt (ADR 0015).
 * `onLoggedIn` runs after approval (model list, prices, layout); its error fails the login with a readable message.
 */
export function cgsLoginProvider(route: LoginRoute, env: NodeJS.ProcessEnv = process.env, onLoggedIn?: (a: LoggedIn) => Promise<unknown>) {
  return {
    name: "Cicori Good Service",
    async login(cb: LoginCallbacks): Promise<CgsCredentials> {
      await route.ready();
      const r = await deviceLogin({
        baseUrl: route.upstream(), signal: cb.signal, fetch: ((i: string | URL | Request, init?: RequestInit) => route.fetch(new Request(i, init))) as typeof fetch,
        onProgress: (e) => { if (e.phase === "waiting") cb.onAuth({ url: e.verificationUrl, instructions: "Approve this device in your browser, then return here." }); else cb.onProgress?.(e.phase === "solving" ? "Solving security check…" : "Creating login session…"); },
      });
      // The credential records the logical origin, not the mirror Bootstrap happened to pick on this network.
      const baseUrl = logicalOrigin(env);
      cb.onProgress?.("Fetching models and prices…");
      await onLoggedIn?.({ baseUrl, clientSecret: r.clientSecret, username: r.username, tier: r.tier });
      return { access: r.clientSecret, refresh: r.clientSecret, expires: Date.now() + LONG_LIVED_MS, enterpriseUrl: baseUrl, email: r.username };
    },
    // The client credential does not expire client-side; a 401 from the server is handled by logging in again.
    refreshToken: async (c: CgsCredentials) => ({ ...c, expires: Date.now() + LONG_LIVED_MS }),
    getApiKey: (c: CgsCredentials) => c.access,
  };
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Registers the CGS channels served by cgsconnect; every request to cgsconnect goes through `via` (a direct call into
 * cgsconnect in production). Credentials: `apiKey` names an environment variable that holds the client credential (the
 * server issues no per-channel slots today); a stored slot login (`oauth`) takes precedence once the server issues them.
 * Channels the manifest no longer has are unregistered.
 */
export async function registerChannels(pi: ExtensionApi, via: FetchFn): Promise<void> {
  const providers = asManifest(await getJson(via, `${CGSCONNECT_ORIGIN}/_cgsconnect/manifest`));
  for (const c of CHANNELS) if (!providers.some((p) => p.id === c)) pi.unregisterProvider?.(c);
  for (const p of providers) {
    pi.registerProvider(p.id, {
      baseUrl: p.baseUrl,
      api: API[p.channel],
      apiKey: p.channel === "cgs-antigravity" ? ANTIGRAVITY_KEY_ENV : SECRET_ENV,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning ?? false,
        input: ["text"],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: { input: m.price?.input ?? 0, output: m.price?.output ?? 0, cacheRead: m.price?.cacheRead ?? 0, cacheWrite: m.price?.cacheWrite ?? 0 },
      })),
      oauth: {
        name: "CGS",
        login: () => slotCredential(via, p.channel),
        refreshToken: () => slotCredential(via, p.channel),
        getApiKey: (c: OAuthCredentials) => c.access,
      },
    });
  }
}

/**
 * omp resolves provider requests with the global fetch, and a provider `baseUrl` must be an HTTP URL. Requests addressed to
 * CGSCONNECT_ORIGIN are handed to cgsconnect by direct call (no port); everything else goes to the original fetch.
 * Returns a function that undoes the diversion.
 */
export function divert(via: FetchFn): () => void {
  const orig = globalThis.fetch;
  const url = (i: string | URL | Request) => (typeof i === "string" ? i : i instanceof URL ? i.href : i.url);
  globalThis.fetch = Object.assign(((i: string | URL | Request, init?: RequestInit) => (url(i).startsWith(CGSCONNECT_ORIGIN) ? via(i, init) : orig(i, init))) as typeof fetch, orig);
  return () => { globalThis.fetch = orig; };
}

/** What a completed login hands to the account sync. */
export interface LoggedIn { baseUrl: string; clientSecret: string; username?: string; tier?: string }

export interface AccountSyncOptions {
  pi: ExtensionApi;
  connect: { router: { fetch(req: Request): Promise<Response> }; hub: ProviderHubImpl; fetch(req: Request): Promise<Response> };
  agentDir: string;
  /** Test seam; production uses applyDefaultLayout from @cgscli/connect. */
  applyLayout?: typeof applyDefaultLayout;
}

/**
 * Everything that follows a login or a start with a stored credential: put the credential where the channels' `apiKey`
 * points, fetch the model list and the prices through the router, hand them to the hub, re-register the channels (omp
 * picks the new models up without a restart), store the account, and apply the server default layout once.
 * Throws a message fit to show the user when no model list can be had.
 */
export async function syncAccount(o: AccountSyncOptions, a: LoggedIn): Promise<string[]> {
  const via = (r: Request) => o.connect.router.fetch(r);
  applyCredentialEnv(a.clientSecret);
  const [ids, pricing] = await Promise.all([fetchModelIds(via, a.baseUrl, a.clientSecret), fetchPricing(via, a.baseUrl, a.clientSecret)]);
  const prior = readAccount(o.agentDir);
  const prices = pricing ?? prior?.pricing ?? {};
  o.connect.hub.setModels(ids, prices);
  await registerChannels(o.pi, (i, init) => o.connect.fetch(new Request(i, init)));
  writeAccount(o.agentDir, { ...a, models: ids, pricing: prices });
  await (o.applyLayout ?? applyDefaultLayout)({ agentDir: o.agentDir, baseUrl: a.baseUrl, clientSecret: a.clientSecret, fetch: via });
  return ids;
}

export default async function cgsExtension(pi: ExtensionApi): Promise<void> {
  const home = process.env.CGSCLI_HOME?.trim() || path.join(os.homedir(), ".cgs");
  const connect = createConnect({ upstream: candidatesFrom(), cloudflare: cloudflareFrom(), dataDir: path.join(home, "connect") });
  process.once("exit", () => connect.stop());
  const agentDir = resolveAgentDir();
  const sync = (a: LoggedIn) => syncAccount({ pi, connect, agentDir }, a);
  pi.registerProvider("cgs", { oauth: cgsLoginProvider(connect.router, process.env, sync) });
  registerComponentCommands(pi);
  registerRemoteCommands(pi);
  divert((i, init) => connect.fetch(new Request(i, init)));
  // A stored account: the channels exist from the last known list at once, then the list and prices are refreshed in the background.
  const account = readAccount(agentDir);
  if (account) {
    applyCredentialEnv(account.clientSecret);
    connect.hub.setModels(account.models, account.pricing);
    await registerChannels(pi, (i, init) => connect.fetch(new Request(i, init)));
    void sync(account).catch((e) => process.stderr.write(`cgs: ${e instanceof Error ? e.message : e}\n`));
  }
}
