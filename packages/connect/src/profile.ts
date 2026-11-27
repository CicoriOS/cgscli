import os from "node:os";
import path from "node:path";

export const CONFIG_DIR_NAME = ".cgs";
/** Variables never inherited into omp: user omp config, AppImage launcher state. */
export const FOREIGN_ENV = /^(PI_|OMP_|APPDIR$|APPIMAGE$|ARGV0$|OWD$)/i;

/**
 * The cgs daemon's runtime directory. cgs names its daemon apart from stock omp (CGS_DAEMON_DIR, `__cgs_worker_daemon`, patch P18), and
 * pins it here, in its own config root, so that restarting one product's daemon never reaches the other's, whatever either shell inherited.
 */
export function daemonDir(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home, env.PI_CONFIG_DIR?.trim() || CONFIG_DIR_NAME, "run", "daemon");
}

export interface ProfileOptions {
  agentDir: string;
  ompBin: string;
  /** CGS overlay file passed to omp via --config (semantics [待验证 V2]). */
  overlayPath?: string;
  /** Extension entry loaded with -e (not copied into the user's agent dir). */
  extensionPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

export interface Profile { env: Record<string, string>; args: string[] }

/**
 * Invariants (see cgsconnect/profile.md): no PI_ or OMP_ variables inherited; config root, agent dir and natives cache all under
 * CGS-owned dirs; PATH additions apply to omp only. Known gap: omp's ~/.omp/browser-state is
 * hard-coded and cannot be moved from here (upstream patch P3).
 */
export function buildProfile(o: ProfileOptions): Profile {
  const base = o.baseEnv ?? process.env;
  const platform = o.platform ?? process.platform;
  const home = o.home ?? os.homedir();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !FOREIGN_ENV.test(k)) env[k] = v;

  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const add = [path.dirname(o.ompBin)];
  const rest = (env[pathKey] ?? "").split(path.delimiter).filter((d) => d && !add.includes(d));
  env[pathKey] = [...add, ...rest].join(path.delimiter);

  if (platform === "linux") env.XDG_DATA_HOME = path.join(path.dirname(o.agentDir), "xdg-data");
  env.PI_CONFIG_DIR = CONFIG_DIR_NAME;
  env.PI_NATIVES_DIR = path.join(home, CONFIG_DIR_NAME, "natives");
  env.PI_CODING_AGENT_DIR = o.agentDir;
  env.CGS_DAEMON_DIR = daemonDir(home, { PI_CONFIG_DIR: CONFIG_DIR_NAME });

  const args: string[] = [];
  if (o.overlayPath) args.push("--config", o.overlayPath);
  if (o.extensionPath) args.push("-e", o.extensionPath);
  return { env, args };
}

/** CGS defaults from legacy config-writer.js, as an overlay document (not written into the user's config.yml). */
export interface OverlayInput {
  modelRoles?: { default?: string; task?: string; web?: string; smol?: string };
  webFallback?: string[];
  agentModelOverrides?: Record<string, string>;
}

export function buildOverlay(i: OverlayInput): Record<string, unknown> {
  const o: Record<string, unknown> = {
    computer: { enabled: true },
    lsp: { enabled: true },
    task: { enableLsp: true, ...(i.agentModelOverrides ? { agentModelOverrides: i.agentModelOverrides } : {}) },
    defaultThinkingLevel: "auto",
    edit: { modelVariants: { claude: "replace", gpt: "apply_patch" } },
  };
  if (i.modelRoles) o.modelRoles = i.modelRoles;
  if (i.webFallback) o.retry = { fallbackChains: { web: i.webFallback } };
  return o;
}
