import os from "node:os";
import path from "node:path";
import { ANTIGRAVITY_KEY_ENV, applyCredentialEnv, applyCurrencyEnv, fetchModelCapabilities, fetchModelIds, fetchPricing, readAccount, SECRET_ENV, writeAccount } from "./account.ts";
import { deviceLogin } from "./login.ts";
import { applyDefaultLayout, CGSCONNECT_ORIGIN, CHANNELS, createConnect, resolveAgentDir, type LayoutResult, type ModelManifest, type ProviderHubImpl } from "@cgscli/connect";
import { candidatesFrom, cloudflareFrom, logicalOrigin } from "./defaults.ts";
import { createUsageProvider } from "./usage.ts";
import { registerConnectCommand } from "./connect.ts";
import { providerTransport } from "./provider-transport.ts";
import { registerUnknownToolGuidance } from "./unknown-tool.ts";
// omp extension: registers the CGS channels from the manifest of cgsconnect, which runs inside the omp process as a
// library (ADR 0014): provider traffic is handed to its router by direct call, so our providers leave through the
// cgsconnect router (direct first, relay tunnel on failure) and nothing listens on a port. Loaded with
// `omp -e <this file>` (profile.ts); replaces the legacy plugin/omp-cgs. No credentials polling: credentials arrive through `oauth`.
//
// Source: ProviderConfig / oauth shapes read from can1357/oh-my-pi @76b7d84
// (packages/coding-agent/src/extensibility/extensions/types.ts). With `oauth` registered, a stored login credential
// takes precedence over `apiKey` (docs/extensions.md), which is what lets omp rotate between sibling slots.

interface OAuthCredentials { refresh: string; access: string; expires: number }

interface CommandContext { ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }
interface ExtensionApi {
  registerProvider(name: string, config: Record<string, unknown>): void;
  unregisterProvider?(name: string): void;
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: CommandContext): Promise<void> }): void;
}

const API: Record<string, string> = {
  "cgs-claude": "anthropic-messages",
  "cgs-antigravity": "google-gemini-cli",
  "cgs-codex": "openai-codex-responses",
  "cgs-openai": "openai-completions",
};
const LONG_LIVED_MS = 365 * 24 * 3600 * 1000;
const ACCOUNT_SYNC_INTERVAL_MS = 30 * 60_000;

async function getJson(via: FetchFn, url: string): Promise<unknown> {
  const r = await via(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`cgsconnect ${new URL(url).pathname}: HTTP ${r.status}`);
  return r.json();
}

function asManifest(v: unknown): ModelManifest["providers"] {
  const o = v && typeof v === "object" ? (v as { providers?: unknown }) : {};
  if (!Array.isArray(o.providers)) throw new Error("cgsconnect manifest malformed");
  return o.providers;
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
 * `onLoggedIn` syncs the account after approval; its error fails the login with a readable message.
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
 * cgsconnect in production). Credentials: `apiKey` names an environment variable that holds the client credential. The
 * relay alone chooses the upstream account, so there are no per-channel credentials (ADR 0022).
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
        input: m.input?.length ? m.input : ["text"],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: { input: m.price?.input ?? 0, output: m.price?.output ?? 0, cacheRead: m.price?.cacheRead ?? 0, cacheWrite: m.price?.cacheWrite ?? 0 },
      })),
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
  globalThis.fetch = Object.assign(providerTransport(via, orig) as typeof fetch, orig);
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

let loggedMissingCapabilities = false;

/**
 * After login, at startup and periodically: fetch the account's models, prices and capabilities, then re-register the
 * channels from the updated hub manifest. Store the account and follow the server's layout unless the user took over.
 * Capabilities (input modalities) take effect at the next start or new session, not in a session already running.
 * Throws a message fit to show the user when no model list can be had.
 */
export async function syncAccount(o: AccountSyncOptions, a: LoggedIn): Promise<string[]> {
  const via = (r: Request) => o.connect.router.fetch(r);
  applyCredentialEnv(a.clientSecret);
  const [ids, pricing, declaredCapabilities] = await Promise.all([
    fetchModelIds(via, a.baseUrl, a.clientSecret),
    fetchPricing(via, a.baseUrl, a.clientSecret),
    fetchModelCapabilities(via, a.baseUrl, a.clientSecret),
  ]);
  if (declaredCapabilities === null && !loggedMissingCapabilities) {
    process.stderr.write("cgs: model capabilities unavailable from /api/device/models; registering text-only models\n");
    loggedMissingCapabilities = true;
  }
  // Do not advertise stale modalities when the server no longer declares them.
  const capabilities = declaredCapabilities ?? {};
  const prior = readAccount(o.agentDir);
  const prices = pricing?.models ?? prior?.pricing ?? {};
  // Prices and amounts are in the relay's display currency; omp prints it for the cgs-* models.
  const currency = pricing?.currency ?? prior?.currency;
  applyCurrencyEnv(currency);
  o.connect.hub.setModels(ids, prices, capabilities);
  await registerChannels(o.pi, (i, init) => o.connect.fetch(new Request(i, init)));
  writeAccount(o.agentDir, { ...a, models: ids, pricing: prices, capabilities, ...(currency ? { currency } : {}) });
  await (o.applyLayout ?? applyDefaultLayout)({ agentDir: o.agentDir, baseUrl: a.baseUrl, clientSecret: a.clientSecret, fetch: via });
  return ids;
}

const LAYOUT_SYNC_REPORT: Record<LayoutResult, [string, "info" | "warning" | "error"]> = {
  applied: ["Layout synced from the cloud.", "info"],
  updated: ["Layout synced from the cloud; future updates will follow again.", "info"],
  "up-to-date": ["Layout already matches the cloud.", "info"],
  "user-managed": ["Layout is user-managed.", "warning"],
  unavailable: ["Could not fetch the layout from the cloud; nothing was changed.", "error"],
};

/**
 * `/agents layout sync (bare /agents stays omp's hub: the builtin takes no arguments, so only the argument form reaches us)`: apply the cloud layout over the user's own edits and follow the cloud again (ADR 0028). Roles the
 * user added that the cloud does not know are left alone.
 */
export function registerAgentCommand(pi: ExtensionApi, o: { agentDir: string; fetch: (req: Request) => Promise<Response>; applyLayout?: typeof applyDefaultLayout }): void {
  pi.registerCommand("agents", {
    description: "layout sync: force the cloud's default model layout onto this machine",
    handler: async (args, ctx) => {
      if (args.trim().replace(/\s+/g, " ") !== "layout sync") return ctx.ui.notify("usage: /agents layout sync", "warning");
      const account = readAccount(o.agentDir);
      if (!account) return ctx.ui.notify("Not logged in to CGS: use /login first.", "error");
      const result = await (o.applyLayout ?? applyDefaultLayout)({ agentDir: o.agentDir, baseUrl: account.baseUrl, clientSecret: account.clientSecret, fetch: o.fetch, force: true });
      ctx.ui.notify(...LAYOUT_SYNC_REPORT[result]);
    },
  });
}

const SESSION_IDENTITY_HOOK = Symbol.for("cgscli.sessionIdentity");

export default async function cgsExtension(pi: ExtensionApi): Promise<void> {
  const home = process.env.CGSCLI_HOME?.trim() || path.join(os.homedir(), ".cgs");
  const connect = createConnect({ upstream: candidatesFrom(), cloudflare: cloudflareFrom(), dataDir: path.join(home, "connect") });
  // omp patch P9 asks here for the wire session id of every cgs-* request (ADR 0022); a stock omp never asks.
  Reflect.set(globalThis, SESSION_IDENTITY_HOOK, (provider: string, sessionId: string) => connect.hub.sessionIdentity(provider, sessionId));
  registerUnknownToolGuidance();
  const agentDir = resolveAgentDir();
  let pendingSync: Promise<string[]> | undefined;
  async function sync(a: LoggedIn) {
    // A login must not be overwritten by a still-running refresh of the previous account.
    const current = (pendingSync ?? Promise.resolve()).catch(() => {}).then(() => syncAccount({ pi, connect, agentDir }, a));
    pendingSync = current;
    try {
      const ids = await current;
      void remote.resume().catch((e) => process.stderr.write(`cgs: remote access: ${e instanceof Error ? e.message : e}\n`));
      return ids;
    }
    finally { if (pendingSync === current) pendingSync = undefined; }
  }
  function refresh(account: LoggedIn | null) {
    if (account && !pendingSync) {
      void sync(account).catch((e) => process.stderr.write(`cgs: ${e instanceof Error ? e.message : e}\n`));
    }
  }
  // One /usage card for the account (its balance and subscriptions are not per channel), on the login provider; read at call time.
  const usage = createUsageProvider("cgs", (r) => connect.router.fetch(r), () => readAccount(agentDir));
  pi.registerProvider("cgs", { oauth: cgsLoginProvider(connect.router, process.env, sync), usage });
  const remote = registerConnectCommand(pi, { agentDir });
  registerAgentCommand(pi, { agentDir, fetch: (r) => connect.router.fetch(r) });
  divert((i, init) => connect.fetch(new Request(i, init)));
  // Register cached models and metadata immediately, then refresh them in the background.
  const account = readAccount(agentDir);
  if (account) {
    applyCredentialEnv(account.clientSecret);
    applyCurrencyEnv(account.currency);
    connect.hub.setModels(account.models, account.pricing, account.capabilities);
    await registerChannels(pi, (i, init) => connect.fetch(new Request(i, init)));
    refresh(account);
    void remote.resume().catch((e) => process.stderr.write(`cgs: remote access: ${e instanceof Error ? e.message : e}\n`));
  }
  const timer = setInterval(() => refresh(readAccount(agentDir)), ACCOUNT_SYNC_INTERVAL_MS);
  timer.unref();
  process.once("exit", () => { clearInterval(timer); connect.stop(); });
}
