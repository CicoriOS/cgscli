import { expect, test } from "bun:test";
import { CGSCONNECT_ORIGIN, CHANNEL_PREFIX } from "@cgscli/connect";
import { providerTransport } from "../provider-transport.ts";

const claude = `${CGSCONNECT_ORIGIN}${CHANNEL_PREFIX}cgs-claude/v1/messages`;
const declarations = ["_write", "_read", "Read", "mcp__workspace__lookup", "plugin_lookup", "_bash"].map(name => ({ name }));
const unused = () => { throw new Error("unexpected fetch target"); };
const toolCall = (name: string, type = "tool_use") => ({ type, name, id: "toolu_42", input: { text: "你好", name } });
const event = (name: string) => `data: ${JSON.stringify({ type: "content_block_start", index: 4, content_block: toolCall(name) })}\n\n`;

function messageInit(body: object): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test" }, body: JSON.stringify(body) };
}

function wireResponse(content: unknown[]) {
  return Response.json({ type: "message", content }, { headers: { etag: '"old"', "x-request-id": "upstream" } });
}

test("only uniquely declared client built-ins normalize; exact names and call IDs win", async () => {
  const untouched = [
    toolCall("_write"), toolCall("Read"), toolCall("READ"), toolCall("Edit"), toolCall("ToolSearch"),
    toolCall("MCP__WORKSPACE__LOOKUP"), toolCall("Plugin_Lookup"), toolCall("__write"),
    toolCall("Bash", "server_tool_use"), toolCall("Web_Search"),
  ];
  const response = wireResponse([toolCall("Write"), ...untouched]);
  const transport = providerTransport(async () => response, unused);
  const result = await transport(claude, messageInit({ tools: [...declarations, { name: "web_search", type: "web_search_20250305" }] }));
  expect((await result.json()).content).toEqual([{ ...toolCall("Write"), name: "_write" }, ...untouched]);
  expect(result.headers.get("etag")).toBeNull();
  expect(result.headers.get("x-request-id")).toBe("upstream");
});
test("Claude file_path arguments become omp path arguments", async () => {
  const response = wireResponse([{ ...toolCall("Write"), input: { file_path: "heart.svg", content: "<svg/>" } }]);
  const transport = providerTransport(async () => response, unused);
  const result = await transport(claude, messageInit({ tools: [{ name: "_write" }] }));
  const content = (await result.json()).content[0];
  expect(content).toMatchObject({ name: "_write", input: { path: "heart.svg", content: "<svg/>" } });
  expect(content.input.file_path).toBeUndefined();
});

test("SSE remains incremental, preserves unrelated frames, and replays with the same call ID", async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const bodies: unknown[] = [];
  const transport = providerTransport(async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("x-api-key")).toBe("test");
    expect(new URL(request.url).search).toBe("?beta=true");
    bodies.push(await request.json());
    return bodies.length === 1
      ? new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "content-length": "1000", "x-request-id": "upstream" } })
      : wireResponse([]);
  }, unused);
  const first = { stream: true, tools: declarations, messages: [{ role: "user", content: "write" }] };
  const result = await transport(new Request(`${claude}?beta=true`, messageInit(first)));
  expect(result.headers.get("content-length")).toBeNull();
  expect(result.headers.get("x-request-id")).toBe("upstream");
  const reader = result.body!.getReader();
  const original = { type: "content_block_start", index: 4, content_block: toolCall("Write") };
  const data = JSON.stringify(original);
  const comma = data.indexOf(",");
  const meta = "event: content_block_start\r\nid: call-frame\r\n: keep\r\n";
  const input = encoder.encode(`${meta}data: ${data.slice(0, comma + 1)}\r\ndata: ${data.slice(comma + 1)}\r\n\r\n`);
  // Split CRLF, JSON and multibyte UTF-8 across transport chunks.
  for (const byte of input) source.enqueue(Uint8Array.of(byte));
  const got = decoder.decode((await reader.read()).value);
  const normalized = { ...original, content_block: { ...original.content_block, name: "_write" } };
  expect(got).toBe(`${meta}data: ${JSON.stringify(normalized)}\r\n\r\n`);
  const rest = ': ping\r\n\r\n' + event("ToolSearch") + 'data: {"type":"content_block_delta","delta":{"partial_json":"你好"}}\n\n' + 'data: [DONE]\n\n';
  source.enqueue(encoder.encode(rest));
  source.close();
  let remaining = "";
  for (let entry = await reader.read(); !entry.done; entry = await reader.read()) remaining += decoder.decode(entry.value);
  expect(remaining).toBe(rest);

  const replay = { ...first, messages: [
    ...first.messages,
    { role: "assistant", content: [normalized.content_block] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_42", content: "ok" }] },
  ] };
  await transport(new URL(`${claude}?beta=true`), messageInit(replay));
  expect(bodies).toEqual([first, replay]);
});

test("only local Anthropic Messages POSTs opt in, without inspecting model names", async () => {
  const response = wireResponse([toolCall("Write")]);
  const fallback = new Response("external");
  const transport = providerTransport(async () => response, async () => fallback);
  const init = messageInit({ model: "claude-test", tools: declarations });
  for (const path of ["cgs-openai/v1/chat/completions", "cgs-codex/v1/responses", "cgs-antigravity/v1/messages", "cgs-claude/v1/messages/count_tokens"]) {
    expect(await transport(`${CGSCONNECT_ORIGIN}${CHANNEL_PREFIX}${path}`, init)).toBe(response);
  }
  expect(await transport(`${CGSCONNECT_ORIGIN}/_cgsconnect/manifest`)).toBe(response);
  expect(await transport(claude)).toBe(response);
  const external = new URL(claude);
  external.hostname += ".example";
  expect(await transport(external, init)).toBe(fallback);
  expect(await transport(claude, messageInit({ tools: [{ name: "plugin_lookup" }] }))).toBe(response);
  const result = await transport(claude, messageInit({ model: "not-a-claude-family", tools: declarations }));
  expect((await result.json()).content[0].name).toBe("_write");
});

test("failed or unparseable provider messages pass through unchanged", async () => {
  const badRequest = new Response("upstream validation", { status: 400, headers: { "content-type": "text/event-stream" } });
  expect(await providerTransport(async () => badRequest, unused)(claude, messageInit({ tools: declarations }))).toBe(badRequest);
  const badJson = new Response("not json", { headers: { "content-type": "application/json" } });
  expect(await providerTransport(async () => badJson, unused)(claude, messageInit({ tools: declarations }))).toBe(badJson);
  const response = wireResponse([toolCall("Write")]);
  expect(await providerTransport(async () => response, unused)(claude, { method: "POST", body: "not json" })).toBe(response);
});
