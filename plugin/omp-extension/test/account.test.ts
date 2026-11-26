import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { createConnect, applyDefaultLayout, normalizeLayout, seedDistributionDefaults, DISABLED_PROVIDERS, resolveAgentDir } from "@cgscli/connect";
import { readAccount } from "../account.ts";
import { registerAgentCommand, syncAccount } from "../index.ts";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-acct-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const LAYOUT = { orchestrator: { model: "cgs-claude/claude-a", thinking: "off" }, agents: [{ name: "task", model: "cgs-openai/deepseek-x", thinking: "max" }], web_model: "cgs-antigravity/gemini-w" };
const ok = (data: unknown) => Response.json({ success: true, data });

/** A fake server behind the router: /v1/models, /api/device/pricing, /api/device/layout. */
function server(o: { models?: string[] | Response; pricing?: Response; layout?: Response } = {}) {
  const seen: string[] = [];
  const handler = async (r: Request) => {
    const p = new URL(r.url).pathname;
    seen.push(`${p} ${r.headers.get("authorization")}`);
    if (p === "/v1/models") return o.models instanceof Response ? o.models : Response.json({ data: (o.models ?? ["claude-a", "gemini-w", "gpt-5", "deepseek-x"]).map((id) => ({ id })) });
    if (p === "/api/device/pricing") return o.pricing ?? ok({ currency: "CNY", unit: "per_million_tokens", models: { "claude-a": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } });
    if (p === "/api/device/layout") return o.layout ?? ok(LAYOUT);
    return new Response("nope", { status: 404 });
  };
  const connect = createConnect({ upstream: "https://cgs.example", cloudflare: { enabled: false }, directFetch: handler } as never);
  return { connect, seen };
}

function pi() {
  const reg: Record<string, any> = {};
  return { reg, api: { registerProvider: (n: string, c: Record<string, unknown>) => void (reg[n] = c), unregisterProvider: (n: string) => void delete reg[n], registerCommand: () => {} } };
}

const login = { baseUrl: "https://cgs.example", clientSecret: "sk-client", username: "u", tier: "lite" };

test("login: models land on the right channels with prices, the account is stored, the layout applied", async () => {
  const agentDir = tmp(), s = server(), p = pi();
  const ids = await syncAccount({ pi: p.api, connect: s.connect, agentDir }, login);
  s.connect.stop();
  expect(ids).toEqual(["claude-a", "deepseek-x", "gemini-w", "gpt-5"]);
  expect(Object.keys(p.reg).sort()).toEqual(["cgs-antigravity", "cgs-claude", "cgs-codex", "cgs-openai"]);
  expect(p.reg["cgs-claude"].models.map((m: any) => m.id)).toEqual(["claude-a"]);
  expect(p.reg["cgs-claude"].models[0].cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  expect(p.reg["cgs-codex"].models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  expect(p.reg["cgs-claude"].apiKey).toBe("CGS_CLIENT_SECRET");
  expect(process.env.CGS_CLIENT_SECRET).toBe("sk-client");
  expect(JSON.parse(process.env.CGS_ANTIGRAVITY_KEY!).token).toBe("sk-client");
  expect(s.seen).toContain("/v1/models Bearer sk-client");
  expect(readAccount(agentDir)?.models).toEqual(ids);
  const cfg = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8"));
  expect(cfg.modelRoles.default).toBe("cgs-claude/claude-a:off");
});

test("an empty model list or a server error fails the login with a readable message and registers nothing", async () => {
  for (const models of [[], new Response("", { status: 500 })]) {
    const agentDir = tmp(), s = server({ models }), p = pi();
    await expect(syncAccount({ pi: p.api, connect: s.connect, agentDir }, login)).rejects.toThrow(/no models available|HTTP 500/);
    s.connect.stop();
    expect(Object.keys(p.reg)).toEqual([]);
    expect(readAccount(agentDir)).toBeNull();
  }
});

test("a failing pricing endpoint does not block the models; they register unpriced (or keep the last known prices)", async () => {
  const agentDir = tmp(), p = pi();
  let s = server();
  await syncAccount({ pi: p.api, connect: s.connect, agentDir }, login);
  s.connect.stop();
  s = server({ pricing: new Response("", { status: 500 }) });
  await syncAccount({ pi: p.api, connect: s.connect, agentDir }, login);
  s.connect.stop();
  expect(p.reg["cgs-claude"].models[0].cost.input).toBe(3);
  const fresh = pi(), d2 = tmp();
  s = server({ pricing: new Response("", { status: 500 }) });
  await syncAccount({ pi: fresh.api, connect: s.connect, agentDir: d2 }, login);
  s.connect.stop();
  expect(fresh.reg["cgs-claude"].models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("re-login replaces the list: channels without models are unregistered", async () => {
  const agentDir = tmp(), p = pi();
  let s = server();
  await syncAccount({ pi: p.api, connect: s.connect, agentDir }, login);
  s.connect.stop();
  s = server({ models: ["claude-b"] });
  await syncAccount({ pi: p.api, connect: s.connect, agentDir }, login);
  s.connect.stop();
  expect(Object.keys(p.reg)).toEqual(["cgs-claude"]);
  expect(p.reg["cgs-claude"].models.map((m: any) => m.id)).toEqual(["claude-b"]);
});

const NEXT = { orchestrator: { model: "cgs-claude/claude-b", thinking: "high" }, agents: [{ name: "explore", model: "cgs-openai/deepseek-y" }], web_model: "" };
const layoutOf = (agentDir: string) => ({ file: path.join(agentDir, "config.yml"), state: path.join(agentDir, "cgs", "state.json") });

test("layout: follows the cloud while the user changes nothing; comments and unrelated keys survive; dropped roles go", async () => {
  const agentDir = tmp(), { file } = layoutOf(agentDir);
  fs.writeFileSync(file, "# mine\ntheme: dark\n");
  const at = (data: unknown) => ({ agentDir, baseUrl: "https://x", clientSecret: "k", fetch: async () => ok(data) });
  expect(await applyDefaultLayout(at(LAYOUT))).toBe("applied");
  let cfg = YAML.parse(fs.readFileSync(file, "utf8"));
  expect(cfg).toMatchObject({ theme: "dark", modelRoles: { default: "cgs-claude/claude-a:off", web: "cgs-antigravity/gemini-w" }, task: { agentModelOverrides: { task: "cgs-openai/deepseek-x:max" } }, retry: { fallbackChains: { web: ["cgs-antigravity/gemini-w"] } } });
  expect(await applyDefaultLayout(at(LAYOUT))).toBe("up-to-date");
  expect(await applyDefaultLayout(at(NEXT))).toBe("updated");
  cfg = YAML.parse(fs.readFileSync(file, "utf8"));
  expect(cfg.modelRoles).toEqual({ default: "cgs-claude/claude-b:high" });
  expect(cfg.task.agentModelOverrides).toEqual({ explore: "cgs-openai/deepseek-y" });
  expect(cfg.retry?.fallbackChains?.web).toBeUndefined();
  expect(cfg.theme).toBe("dark");
  expect(fs.readFileSync(file, "utf8")).toContain("# mine");
});

test("layout: changing even one role locks it for good, with no further fetch, even offline", async () => {
  const agentDir = tmp(), { file, state } = layoutOf(agentDir);
  let calls = 0;
  const at = (data: unknown) => ({ agentDir, baseUrl: "https://x", clientSecret: "k", fetch: async () => { calls++; return ok(data); } });
  expect(await applyDefaultLayout(at(LAYOUT))).toBe("applied");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("cgs-openai/deepseek-x:max", "cgs-openai/mine"));
  calls = 0;
  expect(await applyDefaultLayout(at(NEXT))).toBe("user-managed");
  expect(calls).toBe(0);
  expect(JSON.parse(fs.readFileSync(state, "utf8")).layoutTakeover.at).toBeString();
  expect(await applyDefaultLayout(at(NEXT))).toBe("user-managed");
  expect(await applyDefaultLayout({ agentDir, baseUrl: "https://x", clientSecret: "k", fetch: async () => { throw new Error("offline"); } })).toBe("user-managed");
  expect(YAML.parse(fs.readFileSync(file, "utf8")).task.agentModelOverrides.task).toBe("cgs-openai/mine");
  expect(calls).toBe(0);
});

test("layout: any added, removed or edited role counts as taking over", async () => {
  for (const edit of [
    (t: string) => t.replace("agentModelOverrides:\n    task:", "agentModelOverrides:\n    mine: a/b\n    task:"),
    (t: string) => t.replace(/\n {4}task: .*/, ""),
    (t: string) => t.replace("default: cgs-claude/claude-a:off", "default: other/model"),
    (t: string) => t.replace("web: cgs-antigravity/gemini-w", "web: other/web"),
  ]) {
    const agentDir = tmp(), { file } = layoutOf(agentDir);
    const at = { agentDir, baseUrl: "https://x", clientSecret: "k", fetch: async () => ok(LAYOUT) };
    await applyDefaultLayout(at);
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, edit(before));
    expect(fs.readFileSync(file, "utf8")).not.toBe(before);
    expect(await applyDefaultLayout({ ...at, fetch: async () => ok(NEXT) })).toBe("user-managed");
  }
});

test("layout: a config written by a client that predates takeover tracking is followed only if it matches the layout", async () => {
  const at = (agentDir: string, data: unknown) => ({ agentDir, baseUrl: "https://x", clientSecret: "k", fetch: async () => ok(data) });
  const same = tmp(), { file: f1, state: s1 } = layoutOf(same);
  await applyDefaultLayout(at(same, LAYOUT));
  fs.writeFileSync(s1, JSON.stringify({ defaultsApplied: true }));
  expect(await applyDefaultLayout(at(same, LAYOUT))).toBe("up-to-date");
  expect(await applyDefaultLayout(at(same, NEXT))).toBe("updated");
  expect(YAML.parse(fs.readFileSync(f1, "utf8")).modelRoles.default).toBe("cgs-claude/claude-b:high");
  const edited = tmp(), { file: f2, state: s2 } = layoutOf(edited);
  await applyDefaultLayout(at(edited, LAYOUT));
  fs.writeFileSync(f2, fs.readFileSync(f2, "utf8").replace("claude-a:off", "mine"));
  fs.writeFileSync(s2, JSON.stringify({ defaultsApplied: true }));
  expect(await applyDefaultLayout(at(edited, NEXT))).toBe("user-managed");
});

test("/agent layout sync overwrites the user's edits, clears the takeover and follows the cloud again", async () => {
  const agentDir = tmp(), p = pi(), s = server();
  const file = path.join(agentDir, "config.yml"), state = path.join(agentDir, "cgs", "state.json");
  await syncAccount({ pi: p.api, connect: s.connect, agentDir }, login);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("cgs-openai/deepseek-x:max", "cgs-openai/mine"));
  await syncAccount({ pi: p.api, connect: s.connect, agentDir }, login);
  expect(JSON.parse(fs.readFileSync(state, "utf8")).layoutTakeover).toBeTruthy();
  const notes: string[] = [], cmds: Record<string, { handler(args: string, ctx: unknown): Promise<void> }> = {};
  registerAgentCommand({ ...p.api, registerCommand: (n: string, o: never) => { cmds[n] = o; } }, { agentDir, fetch: (r) => s.connect.router.fetch(r) });
  const ctx = { ui: { notify: (m: string, l?: string) => notes.push(`${l}: ${m}`) } };
  await cmds.agent!.handler("layout  sync", ctx);
  expect(YAML.parse(fs.readFileSync(file, "utf8")).task.agentModelOverrides.task).toBe("cgs-openai/deepseek-x:max");
  expect(JSON.parse(fs.readFileSync(state, "utf8")).layoutTakeover).toBeUndefined();
  expect(notes[0]).toStartWith("info:");
  await cmds.agent!.handler("layout", ctx);
  expect(notes[1]).toContain("usage: /agent layout sync");
  s.connect.stop();
});

test("layout: a failed or unusable response leaves the marker unset so the next login retries", async () => {
  const agentDir = tmp();
  const base = { agentDir, baseUrl: "https://x", clientSecret: "k" };
  expect(await applyDefaultLayout({ ...base, fetch: async () => { throw new Error("offline"); } })).toBe("unavailable");
  expect(await applyDefaultLayout({ ...base, fetch: async () => new Response("", { status: 500 }) })).toBe("unavailable");
  expect(await applyDefaultLayout({ ...base, fetch: async () => ok({ orchestrator: { model: "a b" } }) })).toBe("unavailable");
  expect(fs.existsSync(path.join(agentDir, "config.yml"))).toBe(false);
  expect(await applyDefaultLayout({ ...base, fetch: async () => ok(LAYOUT) })).toBe("applied");
});

test("normalizeLayout rejects bad thinking levels, duplicate agents and web models with a thinking suffix", () => {
  expect(normalizeLayout({ orchestrator: { model: "a/b", thinking: "wild" } })).toBeNull();
  expect(normalizeLayout({ orchestrator: { model: "a/b" }, agents: [{ name: "x", model: "a/c" }, { name: "x", model: "a/d" }] })).toBeNull();
  expect(normalizeLayout({ orchestrator: { model: "a/b" }, web_model: "a/b:max" })).toBeNull();
  expect(normalizeLayout({ orchestrator: { model: "a/b" } })).toEqual({ orchestrator: "a/b", agents: [], webModel: "" });
});

test("distribution defaults: seeded only where absent, user values and comments win, the extension is listed once", () => {
  const agentDir = tmp();
  const file = path.join(agentDir, "config.yml");
  fs.writeFileSync(file, "# keep\ndisabledProviders:\n  - mine\nlsp:\n  enabled: false\nextensions:\n  - /other.ts\n");
  seedDistributionDefaults(agentDir, "/ext.ts");
  seedDistributionDefaults(agentDir, "/ext.ts");
  const text = fs.readFileSync(file, "utf8");
  const cfg = YAML.parse(text);
  expect(text).toContain("# keep");
  expect(cfg.disabledProviders).toEqual(["mine"]);
  expect(cfg.lsp.enabled).toBe(false);
  expect(cfg.computer.enabled).toBe(true);
  expect(cfg.providers.webKeyless).toBe(false);
  expect(cfg.extensions).toEqual(["/other.ts", "/ext.ts"]);
  const fresh = tmp();
  seedDistributionDefaults(fresh);
  expect(YAML.parse(fs.readFileSync(path.join(fresh, "config.yml"), "utf8")).disabledProviders).toEqual(DISABLED_PROVIDERS);
});

test("resolveAgentDir follows PI_CODING_AGENT_DIR, else <home>/<PI_CONFIG_DIR>/agent", () => {
  expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/a/b" } as never, "/h")).toBe("/a/b");
  expect(resolveAgentDir({ PI_CONFIG_DIR: ".cgs" } as never, "/h")).toBe("/h/.cgs/agent");
});
