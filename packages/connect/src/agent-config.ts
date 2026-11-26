// Everything cgs writes into omp's config.yml: the distribution defaults (seeded once, only where a key is absent) and the
// server default layout (followed until the user edits a layout-managed role, ADR 0028). Neither overrides a user's own
// edits made through omp's settings UI (/settings, /agents, /model), which write the same file.
// Ported from the legacy src/cgs/config-writer.js (ompweb-desktop); YAML comments and unrelated keys are preserved.
import { createHash } from "node:crypto";
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
 * With `previous` (the layout this client wrote last), what the cloud has since dropped is removed again.
 */
export function applyLayoutToDocument(doc: YAML.Document, l: Layout, previous?: Layout): void {
  doc.setIn(["modelRoles", "default"], l.orchestrator);
  for (const a of l.agents) doc.setIn(["task", "agentModelOverrides", a.name], a.selector);
  for (const a of previous?.agents ?? []) if (!l.agents.some((n) => n.name === a.name)) doc.deleteIn(["task", "agentModelOverrides", a.name]);
  if (l.webModel) {
    doc.setIn(["modelRoles", "web"], l.webModel);
    doc.setIn(["retry", "fallbackChains", "web"], [l.webModel]);
  } else if (previous?.webModel) {
    doc.deleteIn(["modelRoles", "web"]);
    doc.deleteIn(["retry", "fallbackChains", "web"]);
  }
}

/** What the layout manages in config.yml: every model role, every agent override and the web fallback chain. */
export interface Managed { roles: Record<string, unknown>; agents: Record<string, unknown>; webFallback: unknown }

function managedOf(doc: YAML.Document): Managed {
  const js = (doc.toJS() ?? {}) as Record<string, any>;
  const map = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  return { roles: map(js.modelRoles), agents: map(js.task?.agentModelOverrides), webFallback: js.retry?.fallbackChains?.web ?? null };
}

/** JSON with sorted keys, so two values compare equal whatever order their keys were written in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

function readState(agentDir: string): Record<string, unknown> {
  try { const v: unknown = JSON.parse(fs.readFileSync(stateFile(agentDir), "utf8")); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

function writeState(agentDir: string, patch: Record<string, unknown>): void {
  const next = { ...readState(agentDir), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  writeAtomic(stateFile(agentDir), `${JSON.stringify(next, null, 2)}\n`);
}

interface LayoutState { hash: string; applied: Layout; snapshot: Managed }

async function fetchLayout(o: ApplyLayoutOptions): Promise<Layout | null> {
  try {
    const r = await o.fetch(new Request(`${o.baseUrl.replace(/\/+$/, "")}/api/device/layout`, {
      headers: { Authorization: `Bearer ${o.clientSecret}`, Accept: "application/json" },
      signal: o.signal ?? AbortSignal.timeout(15_000),
    }));
    const body = r.status === 200 ? ((await r.json().catch(() => null)) as { success?: unknown; data?: unknown } | null) : null;
    return body?.success === true ? normalizeLayout(body.data) : null;
  } catch { return null; }
}

export interface ApplyLayoutOptions {
  agentDir: string;
  baseUrl: string;
  clientSecret: string;
  fetch: (req: Request) => Promise<Response>;
  signal?: AbortSignal;
  /** `/agents layout sync`: apply the cloud layout over whatever config.yml says and clear any takeover, then follow again. */
  force?: boolean;
}

export type LayoutResult = "applied" | "updated" | "up-to-date" | "user-managed" | "unavailable";

/**
 * Keep the config's model layout in step with the server's (ADR 0028). Until the user changes any layout-managed role in
 * config.yml (a model role, an agent override, the web fallback chain) every login or start applies what the cloud now
 * says. The first difference from what this client last wrote marks the agent dir `layoutTakeover` in state.json, for good:
 * from then on nothing is fetched and nothing is rewritten. The check reads only local files, so it works offline.
 * A failed fetch or an unusable layout changes nothing; the next login or start tries again. With `force` the user's edits
 * are overwritten and the takeover is cleared, so the dir follows the cloud again.
 */
export async function applyDefaultLayout(o: ApplyLayoutOptions): Promise<LayoutResult> {
  const state = readState(o.agentDir);
  if (state.layoutTakeover && !o.force) return "user-managed";
  const file = configFile(o.agentDir);
  const prior = state.layout as LayoutState | undefined;
  const takeOver = (reason: string): LayoutResult => {
    writeState(o.agentDir, { layoutTakeover: { at: new Date().toISOString(), reason } });
    return "user-managed";
  };

  if (!o.force && prior && stable(managedOf(loadDoc(file).doc)) !== stable(prior.snapshot)) return takeOver("a layout-managed role was changed in config.yml");
  const layout = await fetchLayout(o);
  if (!layout) return "unavailable";
  const hash = createHash("sha256").update(stable(layout)).digest("hex");
  const { doc, text } = loadDoc(file);

  if (!o.force && !prior && state.defaultsApplied === true) {
    // Installed before ADR 0028: follow only when the config is exactly what this layout writes.
    const probe = YAML.parseDocument(text);
    applyLayoutToDocument(probe, layout);
    if (stable(managedOf(probe)) !== stable(managedOf(doc))) return takeOver("config.yml differs from the layout of a client that predates takeover tracking");
    writeState(o.agentDir, { defaultsApplied: undefined, layout: { hash, applied: layout, snapshot: managedOf(doc) } satisfies LayoutState });
    return "up-to-date";
  }
  if (!o.force && prior?.hash === hash) return "up-to-date";

  applyLayoutToDocument(doc, layout, prior?.applied);
  saveDoc(file, doc, text);
  writeState(o.agentDir, { defaultsApplied: undefined, layoutTakeover: undefined, layout: { hash, applied: layout, snapshot: managedOf(doc) } satisfies LayoutState });
  return prior ? "updated" : "applied";
}
