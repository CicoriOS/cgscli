// Everything cgs writes into omp's config.yml: the distribution defaults (seeded once, only where a key is absent) and the
// server default layout (applied once after the first login). Both are DEFAULTS, not locks: omp's own settings UI
// (/settings, /agents, /model) edits the same file and later launches/logins never overwrite those edits.
// Ported from the legacy src/cgs/config-writer.js (ompweb-desktop); YAML comments and unrelated keys are preserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_DIR_NAME } from "./profile.ts";

/** Providers omp probes or offers on its own: local model servers, Apple's on-device model, and the keyless web services. */
export const DISABLED_PROVIDERS = ["ollama", "llama.cpp", "lm-studio", "apple", "local", "web"];

/**
 * Distribution defaults. Each entry is written only when its key is absent from config.yml (so a user's own value wins).
 * `disabledProviders` + `providers.webKeyless` keep omp from probing localhost model servers (a 10 s startup stall when
 * nothing listens) and from using third-party web services the user holds no credential for.
 */
export const DISTRIBUTION_DEFAULTS: readonly (readonly [string[], unknown])[] = [
  [["disabledProviders"], DISABLED_PROVIDERS],
  [["providers", "webKeyless"], false],
  [["computer", "enabled"], true],
  [["lsp", "enabled"], true],
  [["task", "enableLsp"], true],
  [["defaultThinkingLevel"], "auto"],
  [["edit", "modelVariants"], { claude: "replace", gpt: "apply_patch" }],
];

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) {
    if (fromEnv === "~") return home;
    if (fromEnv.startsWith("~/") || fromEnv.startsWith("~\\")) return path.join(home, fromEnv.slice(2));
    return path.resolve(fromEnv);
  }
  return path.join(home, env.PI_CONFIG_DIR?.trim() || CONFIG_DIR_NAME, "agent");
}

const configFile = (agentDir: string) => path.join(agentDir, "config.yml");
const stateFile = (agentDir: string) => path.join(agentDir, "cgs", "state.json");

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

function loadDoc(file: string): { doc: YAML.Document; text: string } {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0]!.message}`);
  if (doc.contents !== null && !YAML.isMap(doc.contents)) throw new Error(`${file} must contain a YAML mapping at the top level`);
  return { doc, text };
}

function saveDoc(file: string, doc: YAML.Document, before: string): void {
  const out = doc.toString({ lineWidth: 0 });
  if (out !== before) writeAtomic(file, out);
}

/** Pure: write the distribution defaults into `doc` where absent, and make sure `extensions` lists `extensionPath`. */
export function seedDocument(doc: YAML.Document, extensionPath?: string): void {
  for (const [keyPath, value] of DISTRIBUTION_DEFAULTS) if (!doc.hasIn(keyPath)) doc.setIn(keyPath, value);
  if (extensionPath) {
    const list = doc.getIn(["extensions"], true);
    if (!YAML.isSeq(list)) { if (!doc.has("extensions")) doc.set("extensions", [extensionPath]); return; }
    if (!list.items.some((i) => (YAML.isScalar(i) ? i.value : i) === extensionPath)) list.add(extensionPath);
  }
}

/** Seed `<agentDir>/config.yml` before omp starts (its startup discovery reads these keys). Idempotent. */
export function seedDistributionDefaults(agentDir: string, extensionPath?: string): void {
  const file = configFile(agentDir);
  const { doc, text } = loadDoc(file);
  seedDocument(doc, extensionPath);
  saveDoc(file, doc, text);
}

// ---- server default layout (GET /api/device/layout) -----------------------------------------------------------

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface Layout { orchestrator: string; agents: { name: string; selector: string }[]; webModel: string }

function selector(entry: unknown, what: string): string {
  const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const model = typeof e.model === "string" ? e.model.trim() : "";
  const thinking = typeof e.thinking === "string" ? e.thinking : "";
  if (thinking && !THINKING.includes(thinking)) throw new Error(`${what}: unknown thinking level "${thinking}"`);
  if (/[\s:]/.test(model)) throw new Error(`${what}: invalid model "${model}"`);
  return model && thinking ? `${model}:${thinking}` : model;
}

/** The `data` of GET /api/device/layout -> validated layout, or null when unusable. */
export function normalizeLayout(data: unknown): Layout | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  try {
    const orchestrator = selector(d.orchestrator, "orchestrator");
    if (!orchestrator) return null;
    const seen = new Set<string>();
    const agents: Layout["agents"] = [];
    for (const a of Array.isArray(d.agents) ? d.agents : []) {
      const name = typeof (a as { name?: unknown })?.name === "string" ? (a as { name: string }).name.trim() : "";
      if (!AGENT_NAME.test(name) || seen.has(name)) return null;
      seen.add(name);
      const sel = selector(a, name);
      if (sel) agents.push({ name, selector: sel });
    }
    const webModel = typeof d.web_model === "string" ? d.web_model.trim() : "";
    if (/[\s:]/.test(webModel)) return null;
    return { orchestrator, agents, webModel };
  } catch { return null; }
}

/**
 * Pure: write a layout into `doc`. The orchestrator becomes `modelRoles.default`, each agent
 * `task.agentModelOverrides.<name>` (the keys omp's task tool reads, the same ones /agents edits), and the web model
 * `modelRoles.web` plus a one-entry `retry.fallbackChains.web` so a search failure surfaces instead of switching provider.
 */
export function applyLayoutToDocument(doc: YAML.Document, l: Layout): void {
  doc.setIn(["modelRoles", "default"], l.orchestrator);
  for (const a of l.agents) doc.setIn(["task", "agentModelOverrides", a.name], a.selector);
  if (l.webModel) {
    doc.setIn(["modelRoles", "web"], l.webModel);
    doc.setIn(["retry", "fallbackChains", "web"], [l.webModel]);
  }
}

function readState(agentDir: string): Record<string, unknown> {
  try { const v: unknown = JSON.parse(fs.readFileSync(stateFile(agentDir), "utf8")); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

export interface ApplyLayoutOptions {
  agentDir: string;
  baseUrl: string;
  clientSecret: string;
  fetch: (req: Request) => Promise<Response>;
  signal?: AbortSignal;
}

/**
 * Apply the server's default layout once per agent dir. A failed fetch or an unusable layout leaves the marker unset, so
 * the next login or startup tries again; once applied (`defaultsApplied`) nothing is ever rewritten, so manual edits in
 * /agents survive.
 */
export async function applyDefaultLayout(o: ApplyLayoutOptions): Promise<"applied" | "already-applied" | "unavailable"> {
  if (readState(o.agentDir).defaultsApplied === true) return "already-applied";
  let layout: Layout | null = null;
  try {
    const r = await o.fetch(new Request(`${o.baseUrl.replace(/\/+$/, "")}/api/device/layout`, {
      headers: { Authorization: `Bearer ${o.clientSecret}`, Accept: "application/json" },
      signal: o.signal ?? AbortSignal.timeout(15_000),
    }));
    const body = r.status === 200 ? ((await r.json().catch(() => null)) as { success?: unknown; data?: unknown } | null) : null;
    if (body?.success === true) layout = normalizeLayout(body.data);
  } catch { return "unavailable"; }
  if (!layout) return "unavailable";
  const file = configFile(o.agentDir);
  const { doc, text } = loadDoc(file);
  applyLayoutToDocument(doc, layout);
  saveDoc(file, doc, text);
  writeAtomic(stateFile(o.agentDir), `${JSON.stringify({ ...readState(o.agentDir), defaultsApplied: true }, null, 2)}\n`);
  return "applied";
}
