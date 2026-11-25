import { expect, test } from "bun:test";
import { buildManifest, displayName } from "../../src/index.ts";

test("model ids read as proper names", () => {
  const cases: [string, string][] = [
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-haiku-5-5", "Haiku 5.5"],
    ["claude-opus-4-1-20250805", "Opus 4.1"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-5.1-codex", "GPT-5.1 Codex"],
    ["gemini-3.8-flash", "Gemini 3.8 Flash"],
    ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
    ["glm-5", "GLM 5"],
  ];
  for (const [id, name] of cases) expect(displayName(id)).toBe(name);
});

test("the manifest shows the alias but keeps the id", () => {
  const m = buildManifest("http://x", ["claude-sonnet-5-5"]);
  expect(m.providers[0]!.models[0]).toMatchObject({ id: "claude-sonnet-5-5", name: "Sonnet 5.5" });
});
