import { CGSCONNECT_ORIGIN, CHANNEL_API, channelOfPath } from "@cgscli/connect";

// omp's built-in client tools (including hidden built-ins), not Anthropic server tools.
const BUILTINS: Record<string, true> = {
  read: true, security_scan: true, bash: true, edit: true, ast_grep: true, ast_edit: true, ask: true,
  debug: true, eval: true, github: true, glob: true, grep: true, find: true, lsp: true, checkpoint: true,
  rewind: true, context_notes: true, new_context: true, task: true, wait: true, todo: true,
  web_search: true, write: true, memory_edit: true, retain: true, recall: true, reflect: true,
  learn: true, manage_skill: true, think: true, yield: true, goal: true,
};

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonObject = Record<string, unknown>;
interface EventResult { changed: boolean; suppress?: boolean }
interface ToolNormalizer {
  block(block: unknown, index?: number): boolean;
  event(event: JsonObject): EventResult;
}

const object = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const fold = (name: string) => name.replace(/^_/, "").toLowerCase();

function normalizeInput(input: JsonObject, target: string): boolean {
  if (target !== "read" && target !== "write" && target !== "edit") return false;
  const filePath = input.file_path;
  if (typeof filePath !== "string") return false;
  if (input.path === undefined) input.path = filePath;
  delete input.file_path;
  return true;
}

function toolNormalizer(request: unknown): ToolNormalizer | undefined {
  const tools = object(request)?.tools;
  if (!Array.isArray(tools)) return;
  const exact = new Set<string>();
  const candidates = new Map<string, string | null>();
  for (const tool of tools) {
    const declaration = object(tool);
    const name = declaration?.name;
    if (!declaration || typeof name !== "string") continue;
    exact.add(name);
    const key = fold(name);
    if (!Object.hasOwn(BUILTINS, key)) continue;
    // A conflicting declaration, including a server-side tool, makes the spelling ambiguous.
    const clientTool = declaration.type === undefined || declaration.type === "custom";
    candidates.set(key, candidates.has(key) || !clientTool ? null : name);
  }
  if (![...candidates.values()].some(name => name !== null)) return;
  const targets = new Map<number, string>();
  const partials = new Map<number, string>();
  return {
    block(block, index) {
      const use = object(block);
      if (use?.type !== "tool_use" || typeof use.name !== "string") return false;
      const mapped = exact.has(use.name) ? use.name : candidates.get(fold(use.name));
      if (!mapped) return false;
      const target = fold(mapped);
      if (index !== undefined) targets.set(index, target);
      let changed = false;
      if (use.name !== mapped) { use.name = mapped; changed = true; }
      const input = object(use.input);
      if (input && normalizeInput(input, target)) changed = true;
      return changed;
    },
    event(event) {
      if (event.type !== "content_block_delta") return { changed: false };
      const index = typeof event.index === "number" ? event.index : undefined;
      const delta = object(event.delta);
      const target = index === undefined ? undefined : targets.get(index);
      if (target === undefined || delta?.type !== "input_json_delta" || typeof delta.partial_json !== "string") return { changed: false };
      const partial = (partials.get(index) ?? "") + delta.partial_json;
      partials.set(index, partial);
      let input: unknown;
      try { input = JSON.parse(partial); } catch { return { changed: false, suppress: true }; }
      const parsed = object(input);
      if (!parsed) return { changed: false };
      const changed = normalizeInput(parsed, target);
      delta.partial_json = JSON.stringify(parsed);
      partials.delete(index);
      return { changed, suppress: false };
    },
  };
}

function normalizedEvent(lines: string[], normalize: ToolNormalizer): string {
  const fields: number[] = [];
  const data: string[] = [];
  for (const [i, line] of lines.entries()) {
    const text = line.replace(/^\uFEFF/, "").replace(/(?:\r\n|\r|\n)$/, "");
    if (text === "data" || text.startsWith("data:")) {
      fields.push(i);
      data.push(text.slice(5).replace(/^ /, ""));
    }
  }
  if (!fields.length) return lines.join("");
  let value: unknown;
  try { value = JSON.parse(data.join("\n")); } catch { return lines.join(""); }
  const event = object(value);
  if (!event) return lines.join("");
  let changed = false;
  if (event.type === "content_block_start") changed = normalize.block(event.content_block, typeof event.index === "number" ? event.index : undefined);
  const delta = normalize.event(event);
  changed ||= delta.changed;
  if (delta.suppress) return "";
  if (!changed) return lines.join("");
  const first = lines[fields[0]]!;
  const eol = first.match(/(?:\r\n|\r|\n)$/)?.[0] ?? "";
  lines[fields[0]!] = `${first.startsWith("\uFEFF") ? "\uFEFF" : ""}data: ${JSON.stringify(event)}${eol}`;
  for (const i of fields.slice(1)) lines[i] = "";
  return lines.join("");
}


function normalizeSse(body: ReadableStream<Uint8Array>, normalize: ToolNormalizer) {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let remainder = "";
  function feed(text: string, controller: TransformStreamDefaultController<Uint8Array>, eof = false) {
    remainder += text;
    let start = 0;
    for (const ending of remainder.matchAll(/\r\n|\r|\n/g)) {
      const end = ending.index + ending[0].length;
      if (!eof && ending[0] === "\r" && end === remainder.length) break; // May be a split CRLF.
      lines.push(remainder.slice(start, end));
      if (ending.index === start) {
        controller.enqueue(encoder.encode(normalizedEvent(lines, normalize)));
        lines.length = 0;
      }
      start = end;
    }
    remainder = remainder.slice(start);
    if (eof && (lines.length || remainder)) controller.enqueue(encoder.encode(lines.join("") + remainder));
  }
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { feed(decoder.decode(chunk, { stream: true }), controller); },
    flush(controller) { feed(decoder.decode(), controller, true); },
  }));
}

function withBody(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  for (const key of ["content-length", "content-encoding", "etag", "content-md5", "digest", "content-digest", "repr-digest"]) headers.delete(key);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export function providerTransport(via: FetchFn, fallback: FetchFn): FetchFn {
  return async (input, init) => {
    const url = URL.parse(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url?.origin !== CGSCONNECT_ORIGIN) return fallback(input, init);
    const route = channelOfPath(url.pathname);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "POST" || route?.rest !== "/v1/messages" || CHANNEL_API[route.channel].api !== "anthropic-messages") return via(input, init);

    const request = new Request(input, init);
    // Work from this turn's declarations only. Neither the request nor the tool_use IDs
    // are changed; on replay the SDK emits the same declared name and correlates by ID.
    const normalize = toolNormalizer(await request.clone().json().catch(() => undefined));
    const response = await via(request);
    if (!normalize || !response.ok || !response.body) return response;
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mime === "text/event-stream") return withBody(response, normalizeSse(response.body, normalize));
    if (mime === "application/json") {
      const copy = response.clone();
      const message = object(await copy.json().catch(() => undefined));
      if (message?.type === "message" && Array.isArray(message.content)) {
        let changed = false;
        for (const block of message.content) if (normalize.block(block)) changed = true;
        if (changed) {
          void response.body.cancel();
          return withBody(response, JSON.stringify(message));
        }
      }
    }
    return response;
  };
}
