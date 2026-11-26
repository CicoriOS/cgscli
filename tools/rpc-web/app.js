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
const hot = (level) => level === "xhigh" || level === "max";
function levelColor(level) {
  if (hot(level)) return ORANGE;
  const t = LEVEL_T[level] ?? 1;
  return `rgb(${BLUE_FROM.map((a, i) => Math.round(a + (BLUE_TO[i] - a) * t)).join(",")})`;
}
const RING_NAME = { idle: "Idle", work: "Working", ok: "Done", fail: "Failed", stop: "Stopped" };

function ring(small) { return h("span", { class: small ? "ring sm" : "ring", role: "img", "data-s": "idle", "aria-label": "Idle", title: "Idle" }); }
function paint(el, state, level) {
  const name = state === "think" ? `Thinking (${level})` : RING_NAME[state];
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
  tools: {}, // toolCallId -> { card, call, result }
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
  const timer = setTimeout(() => { S.pending.delete(id); p.reject(new Error(`${cmd.type}: no answer in 60s`)); }, 60_000);
  S.pending.set(id, { resolve: (v) => { clearTimeout(timer); p.resolve(v); }, reject: (e) => { clearTimeout(timer); p.reject(e); } });
  if (!sendRaw(JSON.stringify({ ...cmd, id }))) { S.pending.delete(id); clearTimeout(timer); p.reject(new Error("not connected")); }
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
    case "bridge_exit": toast(`omp exited (${f.exitCode})`); break;
    case "agent_start": S.streaming = true; startRun(); break;
    case "thinking_level_changed": S.level = f.resolved ?? S.level; S.configured = f.configured ?? S.configured; if (S.run?.state === "think") setRing("think"); break;
    case "model_changed": rpc({ type: "get_state" }).then(applyState).catch(() => {}); break;
    case "message_start": case "message_update": case "message_end": onMessage(f); break;
    case "tool_execution_start": onToolStart(f); break;
    case "tool_execution_end": onToolEnd(f); break;
    case "prompt_result": onPromptResult(f); break;
    case "session_settled": onSettled(); break;
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
  S.run = { state: "work", rings: S.run?.rings ?? [] };
  document.body.classList.add("running");
  setRing("work");
}
/** Sets the state of the running prompt: the composer ring and every ring this run has put into the transcript. */
function setRing(state) {
  if (S.run) { S.run.state = state; for (const r of S.run.rings) paint(r, state, S.level); }
  paint(composerRing, S.run ? state : "idle", S.level);
  renderTree();
}
function onPromptResult(f) {
  const end = f.status === "completed" ? "ok" : f.status === "aborted" ? "stop" : "fail";
  if (S.run) { for (const r of S.run.rings) paint(r, end, S.level); S.run.end = end; }
  if (f.status === "error" && f.error?.message) addError(f.error.message);
}
function onSettled() {
  S.streaming = false;
  document.body.classList.remove("running");
  if (S.run) for (const r of S.run.rings) paint(r, S.run.end ?? "stop", S.level);
  S.run = null;
  paint(composerRing, "idle", S.level);
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
  S.msgs = {}; S.tools = {}; S.run = null;
  S.btw = [];
  setHasMsgs(false);
  setTitle("");
}
function setTitle(t) { S.title = t; $("#title").textContent = t; }
function addError(text) { appendBlock(h("div", { class: "errline" }, text)); }

const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => (p?.type === "text" ? p.text : "")).join(""));

/** Tiny safe markdown: fenced code, headings, lists, paragraphs, inline code/bold/links. */
function md(src) {
  const out = [];
  const lines = src.replace(/\r/g, "").split("\n");
  const inline = (s) => esc(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`<h3>${inline(line.replace(/^#+\s*/, ""))}</h3>`); i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (!line.trim()) { i++; } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*]|\d+\.)\s)/.test(lines[i]); i++) para.push(inline(lines[i]));
      out.push(`<p>${para.join("<br>")}</p>`);
    }
  }
  return out.join("");
}

function argSummary(name, a = {}) {
  const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url ?? a.query ?? a.intent ?? Object.values(a).find((x) => typeof x === "string");
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 140) : "";
}

function toolCard(call) {
  const t = S.tools[call.id] ??= { call, result: null, card: h("details", { class: "tool" }) };
  t.call = call;
  const res = t.result;
  const open = t.card.open;
  t.card.className = `tool${res?.isError ? " err" : ""}`;
  t.card.replaceChildren(
    h("summary", {}, h("span", { class: "name" }, call.name), h("span", { class: "sum" }, argSummary(call.name, call.arguments))),
    h("div", { class: "tb" },
      h("div", { class: "lab" }, "arguments"), h("pre", {}, JSON.stringify(call.arguments ?? {}, null, 2)),
      res ? [h("div", { class: "lab" }, res.isError ? "error" : "result"), h("pre", {}, textOf(res.content).slice(0, 20000) || "(empty)")] : h("div", { class: "lab" }, "running…")),
  );
  t.card.open = open;
  return t.card;
}

/** Fills an assistant body from a (partial) message; keeps open/closed state of thought blocks across re-renders. */
function fillAssistant(body, m) {
  const opened = [...body.querySelectorAll("details.thought")].map((d) => d.open);
  body.replaceChildren();
  let ti = 0;
  for (const c of m.content ?? []) {
    if (c.type === "text" && c.text) body.append(h("div", { html: md(c.text) }));
    else if (c.type === "thinking" && c.thinking) body.append(h("details", { class: "thought", open: opened[ti++] }, h("summary", {}, "Thought"), h("div", {}, c.thinking)));
    else if (c.type === "toolCall") body.append(toolCard(c));
  }
  if (m.stopReason === "error" && m.errorMessage) body.append(h("div", { class: "errline" }, m.errorMessage));
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
    if (f.type === "message_start") { appendBlock(h("div", { class: "msg user" }, h("div", { class: "bubble" }, textOf(m.content)))); if (!S.title) setTitle(textOf(m.content).slice(0, 60)); }
    return;
  }
  if (m.role === "toolResult") {
    const t = S.tools[m.toolCallId];
    if (t) { t.result = m; toolCard(t.call); }
    return;
  }
  if (m.role !== "assistant") return;
  let node = S.msgs[f.messageId];
  if (!node) {
    node = assistantNode(f.messageId, m);
    if (S.run && !S.run.rings.length) { const r = ring(true); paint(r, S.run.state, S.level); S.run.rings.push(r); node.gutter.append(r); }
    appendBlock(node.el);
  }
  const stick = atBottom();
  fillAssistant(node.body, m);
  if (stick) scroller.scrollTop = scroller.scrollHeight;
  const ev = f.assistantMessageEvent?.type ?? "";
  if (S.run && !S.run.end) {
    if (ev.startsWith("thinking_") && ev !== "thinking_end") setRing("think");
    else if (ev.startsWith("text_") || ev.startsWith("toolcall_") || ev === "thinking_end") setRing("work");
  }
}
function onToolStart(f) {
  const t = S.tools[f.toolCallId];
  if (t) toolCard(t.call);
  if (S.run && !S.run.end) setRing("work");
}
function onToolEnd(f) {
  const t = S.tools[f.toolCallId];
  if (!t) return;
  t.result ??= { content: f.result?.content ?? [], isError: !!f.isError };
  toolCard(t.call);
}

/** Renders a saved transcript from get_messages: a ring (final colour) at the first assistant message after each user message. */
function renderHistory(messages) {
  const results = {};
  for (const m of messages) if (m.role === "toolResult") results[m.toolCallId] = m;
  let first = true, n = 0;
  const frag = document.createDocumentFragment();
  for (const m of messages) {
    if (m.role === "user") { frag.append(h("div", { class: "msg user" }, h("div", { class: "bubble" }, textOf(m.content)))); first = true; n++; if (!S.title) setTitle(textOf(m.content).slice(0, 60)); }
    else if (m.role === "assistant") {
      const node = assistantNode(`h${n++}`, m);
      for (const c of m.content ?? []) if (c.type === "toolCall") S.tools[c.id] = { call: c, result: results[c.id] ?? null, card: h("details", { class: "tool" }) };
      fillAssistant(node.body, m);
      if (first) {
        first = false;
        const r = ring(true);
        paint(r, m.stopReason === "error" ? "fail" : m.stopReason === "aborted" ? "stop" : "ok", S.level);
        node.gutter.append(r);
      }
      frag.append(node.el);
    }
  }
  transcript.replaceChildren(frag);
  setHasMsgs(n > 0);
  scroller.scrollTop = scroller.scrollHeight;
}

async function loadSession() {
  try {
    const data = await rpc({ type: "get_messages" });
    S.tools = {}; S.msgs = {};
    setTitle("");
    renderHistory(data?.messages ?? data ?? []);
  } catch (e) { toast(String(e.message ?? e)); }
  await refreshTree();
  if (S.streaming) setRing("work");
}

// ---------------------------------------------------------------- sidebar
const rel = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 86400 * 30 ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 86400 / 30)}mo`;
};
const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;

async function refreshTree() {
  try { S.workspaces = (await api("/api/sessions")).workspaces; } catch (e) { toast(String(e.message ?? e)); }
  renderTree();
  const cur = S.workspaces.flatMap((w) => w.sessions).find((s) => s.path === S.sessionFile);
  if (cur) setTitle(cur.title);
}

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
        }) : h("div", { class: "ws-empty" }, "No chats yet")));
    return el;
  });
  tree.replaceChildren(...nodes);
}

/** Makes the omp child run in `cwd` (restarting it when it runs elsewhere). Returns false when the user declined. */
async function enter(cwd) {
  if (cwd === S.cwd) return true;
  if (S.streaming && !confirm("A task is running in another workspace. Switching restarts omp and aborts it. Continue?")) return false;
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
    if (r?.cancelled) { toast("Switch was cancelled"); return; }
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
$("#new-ws").onclick = async () => {
  const cwd = prompt("Absolute path of the new workspace directory:", "/tmp/");
  if (!cwd) return;
  try {
    await api("/api/workspace", { cwd: cwd.trim() });
    S.expanded[cwd.trim()] = true;
    await newChat(cwd.trim());
  } catch (e) { toast(String(e.message ?? e)); }
};
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
  try { await rpc({ type: "prompt", message: text }); } catch (x) { toast(String(x.message ?? x)); input.value = text; grow(); }
});
$("#plus").onclick = () => {}; // dummy for now

// ---------------------------------------------------------------- ring popover: thinking effort and model
const pop = $("#popover");
let popSeq = 0;
$("#ring-btn").onclick = (e) => { e.stopPropagation(); if (pop.hidden) openPopover(); else pop.hidden = true; };
document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { pop.hidden = true; } });

async function openPopover() {
  pop.hidden = false;
  pop.replaceChildren(h("div", { class: "muted", style: "padding:10px" }, "Loading…"));
  placePopover();
  const mine = ++popSeq;
  try {
    const [lv, pk] = await Promise.all([rpc({ type: "get_available_thinking_levels" }), rpc({ type: "get_model_picker", limit: 60 })]);
    if (mine === popSeq) drawPopover(lv.levels ?? [], pk);
  } catch (e) { pop.hidden = true; toast(String(e.message ?? e)); }
}

function drawPopover(levels, picker) {
  const search = h("input", { class: "search", placeholder: "Search models" });
  const rows = h("div", {});
  const showRows = (pk) => {
    rows.replaceChildren(...pk.rows.flatMap((r, i) => [
      i === pk.recent && pk.recent > 0 ? h("div", { class: "sep" }) : null,
      h("div", { class: "mrow", onclick: () => pickModel(r) }, h("span", { class: "n" }, r.name || r.id), h("span", { class: "p" }, r.provider), h("span", { class: "ck", html: r.current ? ICON.check : "" })),
    ]).filter(Boolean));
    if (!pk.rows.length) rows.replaceChildren(h("div", { class: "muted", style: "padding:8px" }, "No models"));
  };
  let t;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(async () => { try { showRows(await rpc({ type: "get_model_picker", query: search.value, limit: 60 })); } catch (e) { toast(String(e.message ?? e)); } }, 180); });
  showRows(picker);
  pop.replaceChildren(
    h("h4", {}, "Thinking"),
    thinkingSlider(["auto", ...levels.filter((l) => l !== "auto")]),
    h("h4", {}, "Model"), search, rows);
  placePopover();
}
/** Anchors the card to the ring button: above it when there is room, else below, clamped to the viewport. */
function placePopover() {
  const b = $("#ring-btn").getBoundingClientRect(), w = pop.offsetWidth, hgt = pop.offsetHeight;
  const above = b.top - hgt - 8;
  pop.style.left = `${Math.max(8, Math.min(b.right - w, innerWidth - w - 8))}px`;
  pop.style.top = `${above >= 8 ? above : Math.min(b.bottom + 8, Math.max(8, innerHeight - hgt - 8))}px`;
}
/** A stepped slider: Auto first (omp picks the effort per turn), then the levels the live model supports. */
function thinkingSlider(steps) {
  const at = Math.max(0, steps.indexOf(S.configured));
  const name = h("b", {}, steps[at]);
  const range = h("input", { type: "range", class: "slider", min: 0, max: steps.length - 1, step: 1, value: at, "aria-label": "Thinking effort" });
  const tint = () => { range.style.accentColor = steps[range.value] === "auto" ? "#8a8a8a" : levelColor(steps[range.value]); };
  tint();
  range.addEventListener("input", () => { name.textContent = steps[range.value]; tint(); });
  range.addEventListener("change", () => pickLevel(steps[range.value]));
  return h("div", { class: "think" },
    h("div", { class: "think-now" }, "Effort: ", name),
    range,
    h("div", { class: "ticks" }, steps.map((l) => h("span", {}, l === "auto" ? "Auto" : l))));
}
async function pickLevel(level) {
  try { await rpc({ type: "set_thinking_level", level }); applyState(await rpc({ type: "get_state" })); } catch (e) { toast(String(e.message ?? e)); }
}
async function pickModel(r) {
  try {
    await rpc({ type: "set_model", provider: r.provider, modelId: r.id, ...(r.role ? { role: r.role } : {}) });
    applyState(await rpc({ type: "get_state" }));
    pop.hidden = true;
    toast(`Model: ${r.provider}/${r.id}`);
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
