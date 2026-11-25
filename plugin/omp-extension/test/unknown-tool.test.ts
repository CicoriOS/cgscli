import { expect, test } from "bun:test";
import { registerUnknownToolGuidance, unknownToolGuidance } from "../unknown-tool.ts";

const api = "anthropic-messages";
const name = "ToolSearch";

test("uses only the current request's literal wire names and short descriptions", () => {
  const tools = [
    { name: "_write", description: "Create\n  or replace a file" },
    { name: "mcp__notes__lookup", description: "Look up a note" },
    { name: "_edit", description: "x".repeat(200) },
    { name: "_read" },
  ];
  expect(unknownToolGuidance({ api, name, tools })).toBe([
    "Tool ToolSearch is unavailable for this request. Use only tools declared for this request:",
    "- _write: Create or replace a file",
    "- mcp__notes__lookup: Look up a note",
    `- _edit: ${"x".repeat(119)}…`,
    "- _read",
  ].join("\n"));
  expect(unknownToolGuidance({ api, name, tools: [{ name: "write", description: "Different request" }] }))
    .toContain("\n- write: Different request");
  expect(unknownToolGuidance({ api, name, tools: [] })).toBe("Tool ToolSearch is unavailable for this request. No tools were declared for this request.");
  expect(unknownToolGuidance({ api, name })).toBe("Tool ToolSearch is unavailable for this request.");
});

test("leaves other protocols, unknown spellings, and implemented tools alone", () => {
  for (const otherApi of ["openai-codex-responses", "openai-completions", "google-gemini-cli", "anthropic-bedrock"]) {
    expect(unknownToolGuidance({ api: otherApi, name, tools: [] })).toBeUndefined();
  }
  for (const otherName of ["toolsearch", "mcp__server__ToolSearch", "UnexpectedTool", "constructor", "Read", "_write", "Edit", "NotebookEdit", "Agent", "TodoWrite", "WebSearch"]) {
    expect(unknownToolGuidance({ api, name: otherName, tools: [] })).toBeUndefined();
  }
  expect(unknownToolGuidance({ api, name: "ExitPlanMode", tools: [] })).toContain("is unavailable");
});

test("registers one process-scoped callback idempotently", () => {
  const key = Symbol.for("cgscli.unknownToolGuidance");
  const prior = Object.getOwnPropertyDescriptor(globalThis, key);
  try {
    registerUnknownToolGuidance();
    registerUnknownToolGuidance();
    expect(Reflect.get(globalThis, key)).toBe(unknownToolGuidance);
  } finally {
    if (prior) Object.defineProperty(globalThis, key, prior);
    else Reflect.deleteProperty(globalThis, key);
  }
});
