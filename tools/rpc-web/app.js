// Web UI for a headless omp reached through tools/rpc-web/server.ts. Status ring semantics: cgs-client-docs/adr/0030-status-ring.md.
const $ = (s, r = document) => r.querySelector(s);
const SVG = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  chev: `<svg class="i chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>`,
  folder: SVG(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>`),
  check: SVG(`<path d="m5 12 5 5 9-10"/>`),
};

/** Builds an element: attrs `class`, `on<event>`, `html`, others as attributes. */
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------------------------------------------------------- status ring
const BLUE_FROM = [0x7f, 0xe0, 0xe8], BLUE_TO = [0x1d, 0x4e, 0xd8];
const LEVEL_T = { off: 0, minimal: 0.2, low: 0.4, medium: 0.7, high: 1 };
const ORANGE = "#ff8c1a";
const LEVEL_ZH = { off: "关闭", auto: "自动", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
const levelName = (l) => LEVEL_ZH[l] ?? l;
const hot = (level) => level === "xhigh" || level === "max";
function levelColor(level) {
  if (hot(level)) return ORANGE;
  const t = LEVEL_T[level] ?? 1;
  return `rgb(${BLUE_FROM.map((a, i) => Math.round(a + (BLUE_TO[i] - a) * t)).join(",")})`;
}
const RING_NAME = { idle: "待命", work: "处理中", ok: "完成", fail: "失败", stop: "已停止" };

function ring(small) { return h("span", { class: small ? "ring sm" : "ring", role: "img", "data-s": "idle", "aria-label": "待命", title: "待命" }); }
function paint(el, state, level) {
  const name = state === "think" ? `思考中（${levelName(level)}）` : RING_NAME[state];
  el.dataset.s = state;
  el.setAttribute("aria-label", name);
  el.title = name;
  if (state === "think") {
    el.style.setProperty("--c", levelColor(level));
    el.style.setProperty("--dur", hot(level) ? "1.1s" : "2.4s");
  } else {
    el.style.removeProperty("--c");
    el.style.setProperty("--dur", "2.4s");
  }
}

// ---------------------------------------------------------------- state
const S = {
  ws: null, seq: 0, page: Math.random().toString(36).slice(2, 8), pending: new Map(), replaying: true, ready: Promise.withResolvers(),
  cwd: "", activeCwd: "", workspaces: [], expanded: {}, sessionFile: "", title: "",
  model: null, level: "high", configured: "auto", streaming: false,
  run: null, // { state, ringEls: [] } the current prompt run
  msgs: {}, // messageId -> { el, body, ringHost }
  tools: {}, // toolCallId -> { card, call, result, msgId }
  chainOpen: {}, // chain key -> open
  raw: [], btw: [], btwOpen: false, hasMsgs: false,
};
const composerRing = ring();
$("#ring-btn").append(composerRing);

function toast(text) {
  const t = $("#toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4500);
}

// ---------------------------------------------------------------- transport
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = async () => {
    S.replaying = true;
    try { await rpc({ type: "get_state" }).then(applyState); } catch (e) { toast(String(e.message ?? e)); }
    S.replaying = false;
    await loadSession();
  };
  ws.onmessage = (e) => onFrame(e.data);
  ws.onclose = () => { for (const p of S.pending.values()) p.reject(new Error("disconnected")); S.pending.clear(); setTimeout(connect, 1500); };
}

function sendRaw(text) {
  if (S.ws?.readyState !== 1) return false;
  S.ws.send(text);
  rawPush("in", text);
  return true;
}

/** Sends a command and resolves with the response's `data`; rejects with the response's `error`. */
function rpc(cmd) {
  const id = `${S.page}-${++S.seq}`; // unique per page load: the bridge replays old responses on connect
  const p = Promise.withResolvers();
  const timer = setTimeout(() => { S.pending.delete(id); p.reject(new Error(`${cmd.type}：60 秒内没有响应`)); }, 60_000);
  S.pending.set(id, { resolve: (v) => { clearTimeout(timer); p.resolve(v); }, reject: (e) => { clearTimeout(timer); p.reject(e); } });
  if (!sendRaw(JSON.stringify({ ...cmd, id }))) { S.pending.delete(id); clearTimeout(timer); p.reject(new Error("未连接")); }
  return p.promise;
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// ---------------------------------------------------------------- frames
function onFrame(text) {
  rawPush("out", text);
  let f;
  try { f = JSON.parse(text); } catch { return; }
  if (f.type === "response") {
    const p = S.pending.get(f.id);
    if (!p) return;
    S.pending.delete(f.id);
    if (f.success) p.resolve(f.data); else p.reject(new Error(f.error ?? "failed"));
    return;
  }
  if (S.replaying) return; // backlog from before this page connected: the chat is rebuilt from get_state/get_messages
  switch (f.type) {
    case "ready": S.ready.resolve(); break;
    case "bridge_restart": S.ready = Promise.withResolvers(); S.cwd = f.cwd; resetChat(); setRing("idle"); break;
    case "bridge_exit": toast(`omp 已退出（${f.exitCode}）`); break;
    case "agent_start": S.streaming = true; startRun(); break;
    case "thinking_level_changed": S.level = f.resolved ?? S.level; S.configured = f.configured ?? S.configured; if (S.run?.state === "think") setRing("think"); break;
    case "model_changed": rpc({ type: "get_state" }).then(applyState).catch(() => {}); break;
    case "message_start": case "message_update": case "message_end": onMessage(f); break;
    case "tool_execution_start": onToolStart(f); break;
    case "tool_execution_end": onToolEnd(f); break;
    case "prompt_result": onPromptResult(f); break;
    case "session_settled": onSettled(); break;
    case "extension_ui_request": if (f.method === "setTitle") refreshTree(); break; // omp named the session (PI_RPC_EMIT_TITLE): the title itself is read from the session file
    case "btw_record": onBtwRecord(f.record); break;
    case "btw_delta": onBtwDelta(f); break;
  }
}

function applyState(st) {
  S.model = st.model ?? S.model;
  S.level = st.thinkingLevel ?? S.level;
  S.configured = st.configuredThinkingLevel ?? S.configured;
  S.sessionFile = st.sessionFile ?? "";
  S.streaming = !!st.isStreaming;
  document.body.classList.toggle("running", S.streaming);
  if (S.streaming) { S.run ??= { state: "work", rings: [] }; setRing("work"); } else if (!S.run) setRing("idle");
}

// ---------------------------------------------------------------- ring state machine
function startRun() {
  // An auto-retry starts another agent run inside the same prompt: keep the rings the earlier attempts put into the transcript.
  if (S.run) S.run.superseded = true;
  S.run = { state: "work", rings: S.run?.rings ?? [] };
  document.body.classList.add("running");
  setRing("work");
}
const THINK_HOLD_MS = 1500;
let holdRun = null;
/**
 * Sets the state of the running prompt: the composer ring and every ring this run has put into the transcript. A fast model thinks for
 * a fraction of a second, so once the blue thinking ring shows, a following state waits until it has been visible for THINK_HOLD_MS.
 */
function setRing(state) {
  const run = S.run;
  if (run && run.state === "think" && state !== "think" && Date.now() < run.holdUntil) {
    run.want = state;
    holdRun = run;
    run.holdTimer ??= setTimeout(() => { run.holdTimer = undefined; holdRun = null; if (!run.superseded) applyRing(run, run.want); }, run.holdUntil - Date.now());
    return;
  }
  if (run) { if (state === "think" && run.state !== "think") run.holdUntil = Date.now() + THINK_HOLD_MS; run.want = state; }
  applyRing(run, state);
}
function applyRing(run, state) {
  const changed = !run || run.state !== state || run.level !== S.level;
  if (run) { run.state = state; run.level = S.level; if (changed) for (const r of run.rings) paint(r, state, S.level); }
  if (run || !holdRun) paint(composerRing, run && run === S.run ? state : "idle", S.level); // a finished run's hold keeps the composer ring too
  if (changed) renderTree(); // rebuilding the sidebar restarts its ring's animation: only when something changed
}
function onPromptResult(f) {
  const end = f.status === "error" ? "fail" : "idle"; // a plain reply fades back to grey; green is for tool calls
  if (S.run) { S.run.level = S.level; S.run.end = end; setRing(end); }
  if (S.turn && f.status !== "completed") { S.turn.interrupted = true; S.turn.errorText = f.error?.message; } // settled in onSettled: see interruptTurn
  else if (f.status === "error" && f.error?.message) addError(f.error.message);
  if (f.sessionSettled) onSettled(); // an aborted prompt reports its settling here and sends no session_settled frame
}
function onSettled() {
  S.streaming = false;
  document.body.classList.remove("running");
  discardPlaceholder();
  S.pendingUser = undefined;
  if (S.run) setRing(S.run.end ?? "idle");
  if (S.turn) { S.turn.settled = true; if (S.turn.interrupted) interruptTurn(S.turn); renderTurn(S.turn); S.turn = null; }
  const held = S.run?.holdTimer; // the composer ring goes grey with the transcript rings, when the hold ends
  S.run = null;
  if (!held && !holdRun) paint(composerRing, "idle", S.level);
  rpc({ type: "get_state" }).then(applyState).catch(() => {});
  refreshTree();
}

// ---------------------------------------------------------------- transcript
const scroller = $("#scroller"), transcript = $("#transcript");
const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48;
function appendBlock(node) {
  const stick = atBottom();
  transcript.append(node);
  setHasMsgs(true);
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}
function setHasMsgs(v) {
  S.hasMsgs = v;
  document.body.classList.toggle("empty", !v);
}
function resetChat() {
  transcript.replaceChildren();
  S.msgs = {}; S.tools = {}; S.chainOpen = {}; S.run = null; S.pendingUser = undefined; S.pendingAsst = null; S.turn = null;
  S.btw = [];
  setHasMsgs(false);
  setTitle("");
}
function setTitle(t) { S.title = t; $("#title").textContent = t; }
function addError(text) { appendBlock(h("div", { class: "errline" }, text)); }

const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => (p?.type === "text" ? p.text : "")).join(""));

const mermaidCache = {}; // source -> { busy } | { svg } | { error }
let mermaidLoad, mermaidSeq = 0;

/** Mermaid's bundle is optional (the bridge serves /mermaid.min.js when MERMAID_JS is set). */
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/mermaid.min.js";
    s.onload = () => { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" }); resolve(window.mermaid); };
    s.onerror = () => reject(new Error("mermaid is not available on this bridge (set MERMAID_JS)"));
    document.head.append(s);
  });
  return mermaidLoad;
}

function fillMermaid(box) {
  const c = mermaidCache[box.dataset.src];
  if (c?.svg) { box.className = "mermaid-box"; box.innerHTML = c.svg; }
  else if (c?.error) { box.className = "mermaid-box failed"; box.append(h("div", { class: "mm-err" }, c.error)); }
}

async function renderMermaid(src) {
  mermaidCache[src] = { busy: true };
  const id = `mm${++mermaidSeq}`;
  try {
    const lib = await loadMermaid();
    mermaidCache[src] = { svg: (await lib.render(id, src)).svg };
  } catch (e) {
    document.getElementById(`d${id}`)?.remove();
    mermaidCache[src] = { error: String(e.message ?? e).split("\n")[0] };
  }
  for (const box of document.querySelectorAll(".mermaid-box.pending")) if (box.dataset.src === src) fillMermaid(box);
}

function diagramHtml(src) {
  const c = mermaidCache[src];
  if (c?.svg) return `<div class="mermaid-box">${c.svg}</div>`;
  if (!c) renderMermaid(src);
  return `<div class="mermaid-box pending${c?.error ? " failed" : ""}" data-src="${esc(src)}"><pre><code>${esc(src)}</code></pre>${c?.error ? `<div class="mm-err">${esc(c.error)}</div>` : ""}</div>`;
}

const mdInline = (s) => {
  const codes = [];
  const t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
};

const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const MD_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const MD_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const mdCells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function mdBlockStart(lines, i) {
  const l = lines[i];
  return /^(```|#{1,6}\s|>)/.test(l) || MD_LIST.test(l) || MD_RULE.test(l) || (l.includes("|") && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]));
}

function mdList(lines, i) {
  const first = MD_LIST.exec(lines[i]);
  const base = first[1].length, ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    const m = MD_LIST.exec(lines[i]);
    if (!m || m[1].length < base) break;
    if (m[1].length > base) { const [html, next] = mdList(lines, i); items[items.length - 1] += html; i = next; continue; }
    const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
    items.push(task ? `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${mdInline(task[2])}` : mdInline(m[3]));
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  return [`<${tag}>${items.map((x) => `<li${x.startsWith("<input") ? ' class="task"' : ""}>${x}</li>`).join("")}</${tag}>`, i];
}

/** Safe markdown (no raw HTML): headings, paragraphs, emphasis, links, lists (nested, tasks), tables, quotes, rules, code, mermaid and svg fences. */
function md(src) {
  const out = [];
  const lines = src.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const fence = /^```(\S*)/.exec(line);
    const head = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      const closed = i < lines.length; // a fence still streaming stays plain code
      i++;
      const body = code.join("\n"), lang = fence[1].toLowerCase();
      if (closed && lang === "mermaid") out.push(diagramHtml(body));
      else if (closed && lang === "svg") out.push(`<div class="svg-box"><img alt="svg" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}"></div>`);
      else out.push(`<pre><code>${esc(body)}</code></pre>`);
    } else if (head) {
      out.push(`<h${head[1].length}>${mdInline(head[2])}</h${head[1].length}>`); i++;
    } else if (MD_RULE.test(line)) {
      out.push("<hr>"); i++;
    } else if (line.startsWith(">")) {
      const q = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) q.push(lines[i].replace(/^>\s?/, ""));
      out.push(`<blockquote>${md(q.join("\n"))}</blockquote>`);
    } else if (line.includes("|") && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1])) {
      const align = mdCells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${mdInline(c)}</${tag}>`;
      const th = mdCells(line).map((c, k) => cell("th", c, k)).join("");
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(`<tr>${mdCells(lines[i]).map((c, k) => cell("td", c, k)).join("")}</tr>`);
      out.push(`<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`);
    } else if (MD_LIST.test(line)) {
      const [html, next] = mdList(lines, i);
      out.push(html); i = next;
    } else if (!line.trim()) { i++; } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && (!para.length || !mdBlockStart(lines, i)); i++) para.push(mdInline(lines[i]));
      out.push(`<p>${para.join("<br>")}</p>`);
    }
  }
  return out.join("");
}

function argSummary(name, a = {}) {
  const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url ?? a.query ?? a.intent ?? Object.values(a).find((x) => typeof x === "string");
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 140) : "";
}

function toolState(call) {
  const res = S.tools[call.id]?.result;
  return res ? (res.isError ? "fail" : "ok") : S.run ? "work" : "idle";
}

function toolCard(call) {
  const t = S.tools[call.id] ??= { call, result: null, card: h("details", { class: "tool" }) };
  t.call = call;
  const res = t.result;
  let open = t.card.open;
  if (res?.isError && !t.opened) { t.opened = true; open = true; } // a failed call opens its card once
  const r = ring(true);
  paint(r, toolState(call), S.level);
  t.card.className = `tool${res?.isError ? " err" : ""}`;
  t.card.replaceChildren(
    h("summary", {}, r, h("span", { class: "name" }, call.name), h("span", { class: "sum" }, argSummary(call.name, call.arguments))),
    h("div", { class: "tb" },
      h("div", { class: "lab" }, "参数"), h("pre", {}, JSON.stringify(call.arguments ?? {}, null, 2)),
      res ? [h("div", { class: "lab" }, res.isError ? "错误" : "结果"), h("pre", {}, textOf(res.content).slice(0, 20000) || "（空）")] : h("div", { class: "lab" }, "运行中…")),
  );
  t.card.open = open;
  return t.card;
}

/** A run of consecutive tool calls as one collapsed line; opening it shows the cards. A failure opens it once. */
function chain(calls, key) {
  const cards = calls.map(toolCard);
  const states = calls.map(toolState);
  const state = states.includes("work") ? "work" : states.includes("fail") ? "fail" : "ok";
  if (state === "fail" && S.chainOpen[key] === undefined) S.chainOpen[key] = true;
  const r = ring(true);
  paint(r, states.every((x) => x === "idle") ? "idle" : state, S.level);
  const counts = {};
  for (const c of calls) counts[c.name] = (counts[c.name] ?? 0) + 1;
  const names = Object.entries(counts).map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join("、");
  const text = state === "work" ? `正在运行 ${names}…` : state === "fail" ? `${names}：有调用失败` : `使用了 ${names}`;
  const d = h("details", { class: `chain${state === "fail" ? " err" : ""}`, open: !!S.chainOpen[key] },
    h("summary", {}, r, h("span", { class: "cs" }, text)), h("div", { class: "cards" }, cards));
  d.addEventListener("toggle", () => { S.chainOpen[key] = d.open; });
  return d;
}

let turnSeq = 0;
/** A turn is everything between one user message and the reply: its thinking and tool calls fold into one block once the reply starts. */
function newTurn(t0, live) { return { key: `u${++turnSeq}`, t0, live, items: [] }; }

function fmtDur(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function thoughtLine(c, key, streaming) {
  const d = h("details", { class: "thought", open: !!S.chainOpen[key] },
    h("summary", {}, h("span", { class: "cs" }, streaming ? "思考中…" : "思考")), h("div", { class: "tt" }, c.thinking));
  d.addEventListener("toggle", () => { S.chainOpen[key] = d.open; });
  return d;
}

const COPY_ICON = '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
/** The copy button under a reply; shown only while the pointer is near the message (css). */
function copyBar(text) {
  const b = h("button", { type: "button", class: "copy-btn", title: "复制", "aria-label": "复制", html: COPY_ICON });
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = h("textarea", {});
      ta.value = text; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    b.innerHTML = ICON.check; b.title = "已复制";
    setTimeout(() => { b.innerHTML = COPY_ICON; b.title = "复制"; }, 1500);
  });
  return h("div", { class: "actions" }, b);
}

/**
 * A turn that ended in an error or a stop. Nothing of the model's work yet (no thinking, text or tool call): the message goes back
 * to the editor and leaves the transcript. Otherwise the work stays and the user message gets an "edit" button that refills the editor.
 */
function interruptTurn(turn) {
  const started = turn.items.some((it) => (it.m?.content ?? []).some((c) => (c.type === "thinking" && c.thinking) || (c.type === "text" && c.text) || c.type === "toolCall"));
  const user = turn.user;
  if (started) {
    if (turn.errorText && !turn.items.some((it) => it.m?.errorMessage)) addError(turn.errorText);
    if (user) user.el.append(h("button", { type: "button", class: "edit-btn", onclick: () => { input.value = user.text; grow(); input.focus(); } }, "编辑"));
    return;
  }
  user?.el.remove();
  for (const it of turn.items) it.node.el.remove();
  if (!transcript.children.length) setHasMsgs(false);
  if (user && !input.value) { input.value = user.text; grow(); }
  if (turn.errorText) toast(turn.errorText);
}

/**
 * Renders a turn into its assistant nodes. Thinking, tool calls and any text that comes with tool calls go to one process list in the
 * turn's first node: lines (a thought, a tool chain) that open into cards while the model works, then one folded summary line once
 * the reply (text in a message without tool calls) has started. The reply text stays in the node of the message it belongs to.
 */
function renderTurn(turn) {
  const stick = atBottom();
  const proc = [], texts = turn.items.map(() => []);
  let reply = false;
  turn.items.forEach((it, i) => {
    const content = it.m?.content ?? [];
    const hasCall = content.some((c) => c.type === "toolCall");
    for (const c of content) {
      if (c.type === "toolCall") {
        (S.tools[c.id] ??= { call: c, result: null, card: h("details", { class: "tool" }) }).turn = turn;
        proc.push(c);
      } else if (c.type === "text" && c.text) {
        if (hasCall) proc.push(c); else { texts[i].push(c.text); reply = true; }
      } else if (c.type === "thinking" && c.thinking) proc.push(c);
    }
  });
  if (turn.live) { if (reply) turn.t1 ??= Date.now(); else turn.t1 = undefined; }

  let procNode = null;
  if (proc.length) {
    const list = h("div", { class: "plist" });
    let calls = [];
    const flush = () => { if (calls.length) list.append(chain(calls, `${turn.key}:${list.children.length}`)); calls = []; };
    proc.forEach((c, i) => {
      if (c.type === "toolCall") { calls.push(c); return; }
      flush();
      if (c.type === "text") list.append(h("div", { class: "pnote", html: md(c.text) }));
      else list.append(thoughtLine(c, `${turn.key}:${list.children.length}`, !reply && turn === S.turn && !turn.settled && S.run?.state === "think" && i === proc.length - 1));
    });
    flush();
    if (reply) {
      const n = proc.filter((c) => c.type === "toolCall").length;
      const parts = [];
      if (proc.some((c) => c.type === "thinking")) parts.push(`思考了 ${fmtDur((turn.t1 ?? turn.t0) - turn.t0)}`);
      if (n) parts.push(`进行了 ${n} 次调用`);
      const failed = proc.some((c) => c.type === "toolCall" && toolState(c) === "fail");
      const k = `${turn.key}:proc`;
      procNode = h("details", { class: `proc${failed ? " err" : ""}`, open: !!S.chainOpen[k] }, h("summary", {}, parts.join("，")), list);
      procNode.addEventListener("toggle", () => { S.chainOpen[k] = procNode.open; });
    } else procNode = h("div", { class: "proc live" }, list);
  }

  turn.items.forEach((it, i) => {
    const kids = [];
    if (i === 0 && procNode) kids.push(procNode);
    for (const t of texts[i]) kids.push(h("div", { html: md(t) }));
    if (texts[i].length && (!turn.live || turn.settled || it.m?.stopReason)) kids.push(copyBar(texts[i].join("\n\n")));
    if (it.m?.stopReason === "error" && it.m.errorMessage) kids.push(h("div", { class: "errline" }, it.m.errorMessage));
    it.node.body.replaceChildren(...kids);
    if (i > 0) it.node.el.hidden = !kids.length;
  });
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

/** Re-renders the turn that owns a tool call (its chain summarises the calls' states). */
function refreshOwner(toolCallId) {
  const turn = S.tools[toolCallId]?.turn;
  if (turn) renderTurn(turn);
}

function assistantNode(id, m) {
  const gutter = h("div", { class: "gutter" });
  const body = h("div", { class: "body" });
  const el = h("div", { class: "msg asst" }, gutter, body);
  S.msgs[id] = { el, body, gutter };
  return S.msgs[id];
}

function onMessage(f) {
  const m = f.message ?? f.assistantMessageEvent?.partial;
  if (!m) return;
  if (m.role === "user") {
    if (S.pendingUser !== undefined && textOf(m.content).trim() === S.pendingUser) { S.pendingUser = undefined; return; } // already shown
    if (f.type === "message_start") {
      const text = textOf(m.content), el = h("div", { class: "msg user" }, h("div", { class: "bubble" }, text));
      S.turn = newTurn(Date.now(), true);
      S.turn.user = { el, text };
      appendBlock(el);
      if (!S.title) setTitle(text.slice(0, 60));
    }
    return;
  }
  if (m.role === "toolResult") {
    const t = S.tools[m.toolCallId];
    if (t) { t.result = m; refreshOwner(m.toolCallId); }
    return;
  }
  if (m.role !== "assistant") return;
  let node = S.msgs[f.messageId];
  if (!node) {
    if (S.pendingAsst) { // the placeholder (and its ring) becomes this message
      node = S.pendingAsst;
      S.pendingAsst = null;
      delete S.msgs.pending;
      S.msgs[f.messageId] = node;
    } else node = assistantNode(f.messageId, m);
    if (!node.el.isConnected) appendBlock(node.el);
    if (S.run && !S.run.rings.length) { const r = ring(); paint(r, S.run.state, S.level); S.run.rings.push(r); node.gutter.append(r); }
    if (!node.el.isConnected) appendBlock(node.el);
  }
  S.turn ??= newTurn(Date.now(), true);
  let item = S.turn.items.find((x) => x.id === f.messageId);
  if (!item) S.turn.items.push((item = { id: f.messageId, node }));
  item.m = m;
  node.last = m;
  renderTurn(S.turn);
  const ev = f.assistantMessageEvent?.type ?? "";
  if (S.run && !S.run.end) {
    if (ev.startsWith("thinking_") && ev !== "thinking_end") setRing("think");
    else if (ev.startsWith("text_") || ev.startsWith("toolcall_") || ev === "thinking_end") setRing("work");
  }
}
function onToolStart(f) {
  if (S.tools[f.toolCallId]) refreshOwner(f.toolCallId);
  if (S.run && !S.run.end) setRing("work");
}
function onToolEnd(f) {
  const t = S.tools[f.toolCallId];
  if (!t) return;
  t.result ??= { content: f.result?.content ?? [], isError: !!f.isError };
  refreshOwner(f.toolCallId);
}

/** Renders a saved transcript from get_messages: a ring (final colour) at the first assistant message after each user message. */
function renderHistory(messages) {
  const results = {};
  for (const m of messages) if (m.role === "toolResult") results[m.toolCallId] = m;
  const turns = [];
  let turn = null, n = 0;
  const frag = document.createDocumentFragment();
  for (const m of messages) {
    if (m.role === "user") {
      frag.append(h("div", { class: "msg user" }, h("div", { class: "bubble" }, textOf(m.content))));
      turn = newTurn(m.timestamp ?? 0, false);
      turns.push(turn);
      n++;
      if (!S.title) setTitle(textOf(m.content).slice(0, 60));
    } else if (m.role === "assistant") {
      const id = `h${n++}`;
      const node = assistantNode(id, m);
      for (const c of m.content ?? []) if (c.type === "toolCall") S.tools[c.id] = { call: c, result: results[c.id] ?? null, card: h("details", { class: "tool" }) };
      node.last = m;
      if (!turn) { turn = newTurn(m.timestamp ?? 0, false); turns.push(turn); }
      if (!turn.items.length) {
        const r = ring();
        paint(r, m.stopReason === "error" ? "fail" : "idle", S.level);
        node.gutter.append(r);
      }
      turn.items.push({ id, node, m });
      const c = m.content ?? [];
      if (c.some((x) => x.type === "text" && x.text) && !c.some((x) => x.type === "toolCall")) turn.t1 = m.timestamp ?? turn.t0;
      frag.append(node.el);
    }
  }
  transcript.replaceChildren(frag);
  for (const t of turns) renderTurn(t);
  setHasMsgs(n > 0);
  scroller.scrollTop = scroller.scrollHeight;
}

async function loadSession() {
  try {
    const data = await rpc({ type: "get_messages" });
    S.tools = {}; S.msgs = {}; S.chainOpen = {}; S.turn = null;
    setTitle("");
    renderHistory(data?.messages ?? data ?? []);
  } catch (e) { toast(String(e.message ?? e)); }
  await refreshTree();
  if (S.streaming) setRing("work");
}

// ---------------------------------------------------------------- sidebar
const rel = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "刚刚" : s < 3600 ? `${Math.floor(s / 60)} 分钟` : s < 86400 ? `${Math.floor(s / 3600)} 小时` : s < 86400 * 30 ? `${Math.floor(s / 86400)} 天` : `${Math.floor(s / 86400 / 30)} 个月`;
};
const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;

async function refreshTree() {
  try { S.workspaces = (await api("/api/sessions")).workspaces; } catch (e) { toast(String(e.message ?? e)); }
  renderTree();
  const cur = S.workspaces.flatMap((w) => w.sessions).find((s) => s.path === S.sessionFile);
  if (cur) setTitle(cur.title);
}

/** Click the title to rename the session: Enter saves through omp's set_session_name, Esc cancels. omp never overwrites a name set this way. */
$("#title").onclick = () => {
  const span = $("#title");
  if (!S.title || span.querySelector("input")) return;
  const input = h("input", { class: "title-edit", value: S.title, maxlength: "120" });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== S.title) {
      try { await rpc({ type: "set_session_name", name }); setTitle(name); await refreshTree(); } catch (e) { toast(String(e.message ?? e)); setTitle(S.title); }
    } else setTitle(S.title);
  };
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) finish(true); else if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
  span.replaceChildren(input);
  input.focus(); input.select();
};

function renderTree() {
  const tree = $("#tree");
  const nodes = S.workspaces.map((w) => {
    const open = S.expanded[w.cwd] ?? w.cwd === S.activeCwd;
    const el = h("div", { class: `ws${open ? " open" : ""}${w.cwd === S.activeCwd ? " current" : ""}` },
      h("div", { class: "ws-head", title: w.cwd, onclick: () => { S.expanded[w.cwd] = !(S.expanded[w.cwd] ?? w.cwd === S.activeCwd); renderTree(); } },
        h("span", { html: ICON.chev }), h("span", { html: ICON.folder }), h("span", { class: "name" }, base(w.cwd))),
      h("div", { class: "ws-sessions" },
        w.sessions.length ? w.sessions.map((s) => {
          const live = S.run && s.path === S.sessionFile;
          const mark = live ? (() => { const r = ring(true); paint(r, S.run.state, S.level); return r; })() : h("span", { class: "age" }, rel(s.updatedAt));
          return h("div", { class: `sess${s.path === S.sessionFile ? " active" : ""}`, title: s.title, onclick: () => openSession(w.cwd, s.path) }, h("span", { class: "t" }, s.title), mark);
        }) : h("div", { class: "ws-empty" }, "暂无对话")));
    return el;
  });
  tree.replaceChildren(...nodes);
}

/** Makes the omp child run in `cwd` (restarting it when it runs elsewhere). Returns false when the user declined. */
async function enter(cwd) {
  if (cwd === S.cwd) return true;
  if (S.streaming && !confirm("另一个工作区里有任务正在运行。切换会重启 omp 并中止它，继续吗？")) return false;
  const r = await api("/api/cwd", { cwd });
  S.cwd = r.cwd;
  if (r.restarted) await S.ready.promise;
  return true;
}
async function openSession(cwd, path) {
  if (path === S.sessionFile) return;
  try {
    if (!(await enter(cwd))) return;
    S.activeCwd = cwd;
    resetChat();
    const r = await rpc({ type: "switch_session", sessionPath: path });
    if (r?.cancelled) { toast("切换已取消"); return; }
    applyState(await rpc({ type: "get_state" }));
    await loadSession();
  } catch (e) { toast(String(e.message ?? e)); }
}
async function newChat(cwd = S.activeCwd || S.cwd) {
  try {
    if (!(await enter(cwd))) return;
    S.activeCwd = cwd;
    resetChat();
    await rpc({ type: "new_session" });
    applyState(await rpc({ type: "get_state" }));
    await refreshTree();
    $("#input").focus();
  } catch (e) { toast(String(e.message ?? e)); }
}
$("#new-chat").onclick = () => newChat();
// Add workspace: a spotlight-style box that suggests directories while a path is typed.
const wsDialog = $("#ws-dialog"), wsInput = $("#ws-input"), wsList = $("#ws-list"), wsHint = $("#ws-hint");
const wsState = { entries: [], exists: false, sel: -1, seq: 0 };
async function wsRefresh() {
  const mine = ++wsState.seq;
  let r = { exists: false, entries: [] };
  try { r = await api(`/api/complete?path=${encodeURIComponent(wsInput.value)}`); } catch { /* keep an empty list */ }
  if (mine !== wsState.seq) return;
  wsState.entries = r.entries;
  wsState.exists = r.exists;
  wsState.sel = -1;
  drawWs();
}
function drawWs() {
  wsList.replaceChildren(...wsState.entries.map((p, i) => h("div", { class: `ws-row${i === wsState.sel ? " sel" : ""}`, onclick: () => wsOpen(p) }, h("span", { html: ICON.folder }), h("span", { class: "p" }, p))));
  wsHint.textContent = !wsInput.value.startsWith("/") ? "请输入以 / 开头的绝对路径"
    : wsState.sel >= 0 ? "回车：添加所选目录"
    : wsState.exists ? "回车：在此目录添加工作区　Tab：补全　↑↓：选择"
    : "回车：创建此目录并添加　Tab：补全　↑↓：选择";
}
function wsClose() { wsDialog.hidden = true; }
async function wsOpen(p) {
  const cwd = p.trim().replace(/\/+$/, "") || "/";
  if (!cwd.startsWith("/")) { toast("请输入以 / 开头的绝对路径"); return; }
  wsClose();
  try {
    await api("/api/workspace", { cwd });
    S.expanded[cwd] = true;
    await newChat(cwd);
  } catch (e) { toast(String(e.message ?? e)); }
}
$("#new-ws").onclick = () => {
  wsDialog.hidden = false;
  wsInput.value = "/";
  wsInput.focus();
  wsRefresh();
};
wsDialog.addEventListener("mousedown", (e) => { if (e.target === wsDialog) wsClose(); });
wsInput.addEventListener("input", wsRefresh);
wsInput.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const n = wsState.entries.length;
  if (e.key === "Escape") wsClose();
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!n) return;
    wsState.sel = e.key === "ArrowDown" ? (wsState.sel + 1) % n : (wsState.sel <= 0 ? n - 1 : wsState.sel - 1);
    drawWs();
    wsList.children[wsState.sel]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Tab") {
    e.preventDefault();
    const target = wsState.entries[Math.max(0, wsState.sel)];
    if (target) { wsInput.value = `${target}/`; wsRefresh(); }
  } else if (e.key === "Enter") {
    e.preventDefault();
    wsOpen(wsState.sel >= 0 ? wsState.entries[wsState.sel] : wsInput.value);
  }
});
$("#toggle-side").onclick = () => document.body.classList.toggle("side-hidden");
$("#toggle-right").onclick = () => { const r = $("#right"); r.hidden = !r.hidden; };

// ---------------------------------------------------------------- composer
const input = $("#input");
const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 220)}px`; };
input.addEventListener("input", grow);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (S.streaming) { rpc({ type: "abort" }).catch((x) => toast(String(x.message ?? x))); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = ""; grow();
  const pending = showPending(text);
  try {
    const r = await rpc({ type: "prompt", message: text });
    if (r?.agentInvoked === false) dropPending(pending, false); // handled locally (a slash command): no model turn follows
  } catch (x) { dropPending(pending, true); toast(String(x.message ?? x)); input.value = text; grow(); }
});

/** Puts the message and a white (waiting) ring into the transcript at once; omp's own frames take them over when they arrive. */
function showPending(text) {
  const user = h("div", { class: "msg user" }, h("div", { class: "bubble" }, text));
  appendBlock(user);
  if (!S.title) setTitle(text.slice(0, 60));
  S.streaming = true;
  document.body.classList.add("running");
  S.run = { state: "work", level: S.level, rings: [] };
  S.turn = newTurn(Date.now(), true);
  S.turn.user = { el: user, text };
  const node = assistantNode("pending", {});
  const r = ring();
  paint(r, "work", S.level);
  S.run.rings.push(r);
  node.gutter.append(r);
  appendBlock(node.el);
  S.pendingUser = text;
  S.pendingAsst = node;
  setRing("work");
  return { user, node };
}
function discardPlaceholder() {
  if (!S.pendingAsst) return;
  S.pendingAsst.el.remove();
  delete S.msgs.pending;
  S.pendingAsst = null;
}
function dropPending(p, withUser) {
  S.pendingUser = undefined;
  discardPlaceholder();
  if (withUser) { p.user.remove(); if (!transcript.children.length) setHasMsgs(false); }
  S.streaming = false;
  S.run = null; S.turn = null;
  document.body.classList.remove("running");
  setRing("idle");
}
$("#plus").onclick = () => {}; // dummy for now

// ---------------------------------------------------------------- ring popover: thinking effort and model
const pop = $("#popover");
let popSeq = 0, popQuery = "";
$("#ring-btn").onclick = (e) => { e.stopPropagation(); if (pop.hidden) openPopover(); else pop.hidden = true; };
document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { pop.hidden = true; } });

async function openPopover() {
  pop.hidden = false;
  pop.replaceChildren(h("div", { class: "muted", style: "padding:10px" }, "加载中…"));
  placePopover();
  popQuery = "";
  await refreshPopover();
}
/** (Re)draws the card from the live state; picking a model calls it again so the card stays open with the new model's efforts. */
async function refreshPopover() {
  const mine = ++popSeq;
  try {
    const [lv, pk] = await Promise.all([rpc({ type: "get_available_thinking_levels" }), rpc({ type: "get_model_picker", query: popQuery || undefined, limit: 60 })]);
    if (mine === popSeq && !pop.hidden) drawPopover(lv.levels ?? [], pk);
  } catch (e) { pop.hidden = true; toast(String(e.message ?? e)); }
}

function drawPopover(levels, picker) {
  const search = h("input", { class: "search", placeholder: "搜索模型", value: popQuery });
  const rows = h("div", {});
  const showRows = (pk) => {
    rows.replaceChildren(...pk.rows.flatMap((r, i) => [
      i === pk.recent && pk.recent > 0 ? h("div", { class: "sep" }) : null,
      h("div", { class: "mrow", onclick: () => pickModel(r) }, h("span", { class: "n" }, r.name || r.id), h("span", { class: "p" }, r.provider), h("span", { class: "ck", html: r.current ? ICON.check : "" })),
    ]).filter(Boolean));
    if (!pk.rows.length) rows.replaceChildren(h("div", { class: "muted", style: "padding:8px" }, "没有匹配的模型"));
  };
  let t;
  search.addEventListener("input", () => { popQuery = search.value; clearTimeout(t); t = setTimeout(async () => { try { showRows(await rpc({ type: "get_model_picker", query: popQuery, limit: 60 })); } catch (e) { toast(String(e.message ?? e)); } }, 180); });
  showRows(picker);
  pop.replaceChildren(
    h("h4", {}, "思考强度"),
    thinkingSlider(["off", "auto", ...levels.filter((l) => l !== "off" && l !== "auto")]),
    h("h4", {}, "模型"), search, rows);
  placePopover();
}
/** Anchors the card to the ring button: above it when there is room, else below, clamped to the viewport. */
function placePopover() {
  const b = $("#ring-btn").getBoundingClientRect(), w = pop.offsetWidth, hgt = pop.offsetHeight;
  const above = b.top - hgt - 8;
  pop.style.left = `${Math.max(8, Math.min(b.right - w, innerWidth - w - 8))}px`;
  pop.style.top = `${above >= 8 ? above : Math.min(b.bottom + 8, Math.max(8, innerHeight - hgt - 8))}px`;
}
/** A stepped slider: Off, then Auto (omp picks the effort per turn), then the efforts the live model offers, low to high. */
function thinkingSlider(steps) {
  const at = Math.max(0, steps.indexOf(S.configured));
  const last = Math.max(1, steps.length - 1);
  const name = h("b", {}, levelName(steps[at]));
  const range = h("input", { type: "range", min: 0, max: steps.length - 1, step: 1, value: at, "aria-label": "思考强度" });
  const box = h("div", { class: "sl" }, range);
  const sync = () => {
    const step = steps[range.value], c = step === "auto" ? "#8a8a8a" : levelColor(step);
    box.style.setProperty("--t", String(range.value / last));
    box.style.setProperty("--c1", c);
    box.style.setProperty("--c2", `color-mix(in srgb, ${c} 45%, #fff)`);
    box.classList.toggle("hot", hot(step));
    name.textContent = levelName(step);
  };
  sync();
  range.addEventListener("input", sync);
  range.addEventListener("change", () => pickLevel(steps[range.value]));
  box.append(h("div", { class: "ticks" }, steps.map((l, i) => h("span", { style: `--t:${i / last}` }, levelName(l)))));
  return h("div", { class: "think" }, h("div", { class: "think-now" }, "强度：", name), box);
}
async function pickLevel(level) {
  try { await rpc({ type: "set_thinking_level", level }); applyState(await rpc({ type: "get_state" })); } catch (e) { toast(String(e.message ?? e)); }
}
async function pickModel(r) {
  try {
    await rpc({ type: "set_model", provider: r.provider, modelId: r.id, ...(r.role ? { role: r.role } : {}) });
    applyState(await rpc({ type: "get_state" }));
    await refreshPopover();
  } catch (e) { toast(String(e.message ?? e)); }
}

// ---------------------------------------------------------------- btw
const btwPanel = $("#btw-panel");
$("#btw-btn").onclick = async () => {
  S.btwOpen = btwPanel.hidden;
  btwPanel.hidden = !S.btwOpen;
  if (!S.btwOpen) return;
  $("#btw-input").focus();
  try { S.btw = (await rpc({ type: "get_btw_history" })).records ?? []; drawBtw(); } catch (e) { toast(String(e.message ?? e)); }
};
$("#btw-close").onclick = () => { btwPanel.hidden = true; S.btwOpen = false; };
$("#btw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#btw-input").value.trim();
  if (!q) return;
  $("#btw-input").value = "";
  try { onBtwRecord((await rpc({ type: "btw", question: q })).record); } catch (x) { toast(String(x.message ?? x)); }
});
$("#btw-cancel").onclick = () => rpc({ type: "btw_cancel" }).catch((x) => toast(String(x.message ?? x)));
function onBtwRecord(rec) {
  if (!rec) return;
  const i = S.btw.findIndex((r) => r.id === rec.id);
  if (i >= 0) S.btw[i] = rec; else S.btw.unshift(rec);
  drawBtw();
}
function onBtwDelta(f) {
  const rec = S.btw.find((r) => r.id === f.recordId);
  if (!rec) return;
  rec.answer = (rec.answer ?? "") + f.delta;
  drawBtw();
}
function drawBtw() {
  $("#btw-cancel").hidden = !S.btw.some((r) => r.status === "running");
  $("#btw-list").replaceChildren(...S.btw.map((r) => h("div", { class: "btw-item" },
    h("div", { class: "q" }, r.question),
    h("div", { class: "a" }, r.answer || (r.status === "running" ? "…" : "")),
    r.status && r.status !== "complete" ? h("div", { class: "st" }, r.status) : null)));
}

// ---------------------------------------------------------------- raw RPC drawer
const rpcBox = $("#rpc"), rpcLog = $("#rpc-log");
const RAW_CAP = 3000;
function rawRow(r) {
  let obj, label = "?";
  try { obj = JSON.parse(r.text); label = obj.type + (obj.command ? `:${obj.command}` : ""); } catch { label = "(not json)"; }
  const preview = r.text.length > 160 ? `${r.text.slice(0, 160)}…` : r.text;
  const d = h("details", { class: `${r.dir}${obj?.success === false ? " err" : ""}` });
  d.append(h("summary", {}, h("span", { class: "t" }, `${r.dir === "in" ? "→" : "←"} ${label}`), " ", h("span", { class: "p" }, preview)));
  d.addEventListener("toggle", () => { if (d.open && !d.querySelector("pre")) d.append(h("pre", {}, obj ? JSON.stringify(obj, null, 2) : r.text)); });
  return { d, label };
}
const rawVisible = (r) => $("#rpc-stream").checked || !r.text.startsWith('{"type":"message_update"');
function rawPush(dir, text) {
  const r = { dir, text };
  S.raw.push(r);
  if (S.raw.length > RAW_CAP) S.raw.splice(0, S.raw.length - RAW_CAP);
  if (rpcBox.hidden) return;
  if (rawVisible(r)) { const stick = rpcLog.scrollTop + rpcLog.clientHeight >= rpcLog.scrollHeight - 30; rpcLog.append(rawRow(r).d); if (stick) rpcLog.scrollTop = rpcLog.scrollHeight; }
  $("#rpc-count").textContent = `${S.raw.length} frames`;
}
function rawRedraw() {
  rpcLog.replaceChildren(...S.raw.filter(rawVisible).slice(-1000).map((r) => rawRow(r).d));
  $("#rpc-count").textContent = `${S.raw.length} frames`;
  rpcLog.scrollTop = rpcLog.scrollHeight;
}
$("#rpc-pill").onclick = () => { rpcBox.hidden = !rpcBox.hidden; if (!rpcBox.hidden) rawRedraw(); };
$("#rpc-hide").onclick = () => (rpcBox.hidden = true);
$("#rpc-stream").onchange = rawRedraw;
$("#rpc-open").onclick = () => rpcLog.querySelectorAll("details").forEach((d) => (d.open = true));
$("#rpc-close").onclick = () => rpcLog.querySelectorAll("details").forEach((d) => (d.open = false));
$("#rpc-clear").onclick = () => { S.raw = []; rawRedraw(); };
$("#rpc-form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#rpc-raw").value.trim(); if (v) { sendRaw(v); $("#rpc-raw").value = ""; } });

// ---------------------------------------------------------------- start
(async () => {
  try { const info = await api("/api/info"); S.cwd = S.activeCwd = info.cwd; } catch (e) { toast(String(e.message ?? e)); }
  setHasMsgs(false);
  connect();
  setInterval(renderTree, 30_000);
})();
