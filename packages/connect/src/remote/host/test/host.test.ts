import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Host } from "../index.ts";
import {
  alive,
  attach,
  call,
  childIds,
  childOf,
  type ChildStatus,
  DEVICE,
  type Frame,
  frames,
  get,
  header,
  type Link,
  listChildren,
  makeHost,
  openChild,
  post,
  retire,
  type Sandbox,
  sandbox,
  sendFrame,
  teardown,
  titleLine,
  until,
  userLine,
} from "./helpers.ts";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(async () => {
  await teardown(sb);
});

/** Creates a child in `cwd` and attaches one socket to it, waiting until the socket is open. */
async function openAttached(host: Host, cwd: string): Promise<{ id: string; link: Link }> {
  const created = childOf((await openChild(host, cwd)).body);
  const link = attach(host, created.id);
  await until(() => link.state === "open", `socket open for ${created.id}`);
  return { id: created.id, link };
}

async function statusOf(host: Host, cid: string): Promise<ChildStatus> {
  const found = (await listChildren(host)).find((child) => child.id === cid);
  if (!found) throw new Error(`child ${cid} is not listed`);
  return found;
}

/** The command types the child has received, as its own get_log reports them. */
async function logTypes(host: Host, cid: string, link: Link): Promise<string[]> {
  const res = await call(host, cid, link, { type: "get_log" });
  return res.data.commands.map((c: Frame) => c.type);
}

describe("routes", () => {
  test("info reports the default cwd, agent dir and device", async () => {
    const host = makeHost(sb, { defaultCwd: "/launch" });
    const res = await get(host, "/api/info");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cwd: "/launch", agentDir: sb.agentDir, device: DEVICE });
  });

  test("info reports an empty cwd when no default is set", async () => {
    const host = makeHost(sb);
    expect((await get(host, "/api/info")).body).toEqual({ cwd: "", agentDir: sb.agentDir, device: DEVICE });
  });

  test("sessions group by workspace, newest first, and skip unused, hidden and non-session files", async () => {
    const wsA = sb.workspace("a");
    const wsB = sb.workspace("b");
    const dflt = sb.workspace("dflt");
    const remembered = sb.workspace("remembered");
    const fileA = sb.session("a-dir", "one.jsonl", [header("s-a", wsA), titleLine("Named session")], 2000);
    const fileB = sb.session("b-dir", "two.jsonl", [header("s-b", wsB), userLine("first   line\nsecond")], 3000);
    sb.session("b-dir", "unused.jsonl", [header("s-u", wsB)], 4000);
    sb.session("b-dir", ".hidden.jsonl", [header("s-h", wsB), titleLine("Hidden")], 5000);
    sb.write(path.join("sessions", "b-dir", "notes.txt"), "not a session");
    sb.write(path.join("cgs", "web-workspaces.json"), `${JSON.stringify([remembered, wsA])}\n`);

    const host = makeHost(sb, { defaultCwd: dflt });
    const res = await get(host, "/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workspaces: [
        {
          cwd: wsB,
          sessions: [{ path: fileB, id: "s-b", title: "first line second", updatedAt: fs.statSync(fileB).mtimeMs }],
        },
        {
          cwd: wsA,
          sessions: [{ path: fileA, id: "s-a", title: "Named session", updatedAt: fs.statSync(fileA).mtimeMs }],
        },
        { cwd: dflt, sessions: [] },
        { cwd: remembered, sessions: [] },
      ],
    });
  });

  test("a malformed remembered-workspaces file lists no workspaces", async () => {
    sb.write(path.join("cgs", "web-workspaces.json"), "{not json");
    const host = makeHost(sb);
    expect((await get(host, "/api/sessions")).body).toEqual({ workspaces: [] });
  });

  test("POST /api/workspace creates the directory and remembers it once", async () => {
    const made = path.join(sb.root, "ws", "made");
    const host = makeHost(sb);

    const res = await post(host, "/api/workspace", { cwd: made });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cwd: made });
    expect(fs.statSync(made).isDirectory()).toBe(true);

    await post(host, "/api/workspace", { cwd: made });
    const file = path.join(sb.agentDir, "cgs", "web-workspaces.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([made]);

    expect((await get(host, "/api/sessions")).body).toEqual({ workspaces: [{ cwd: made, sessions: [] }] });
  });

  test("complete lists the directories a typed path can continue to", async () => {
    const dir = sb.workspace("complete");
    for (const name of ["alpha", "alpine", "beta", ".hidden"]) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, "gamma.txt"), "a file");
    const host = makeHost(sb);
    const complete = (typed: string) => get(host, `/api/complete?path=${encodeURIComponent(typed)}`);

    expect((await complete(path.join(dir, "al"))).body).toEqual({
      exists: false,
      entries: [path.join(dir, "alpha"), path.join(dir, "alpine")],
    });
    expect((await complete(path.join(dir, "alpha"))).body).toEqual({ exists: true, entries: [path.join(dir, "alpha")] });
    expect((await complete(`${dir}/`)).body).toEqual({
      exists: true,
      entries: [path.join(dir, "alpha"), path.join(dir, "alpine"), path.join(dir, "beta")],
    });
    expect((await complete(path.join(dir, ".h"))).body).toEqual({ exists: false, entries: [path.join(dir, ".hidden")] });
    expect((await complete("al")).body).toEqual({ exists: false, entries: [] });
  });

  test("invalid requests are refused and create no child", async () => {
    const host = makeHost(sb);
    const ws = sb.workspace("valid");

    expect(await post(host, "/api/workspace", { cwd: "relative" })).toMatchObject({
      status: 400,
      body: { error: "cwd must be an absolute path" },
    });
    expect(await post(host, "/api/children", { cwd: "relative" })).toMatchObject({
      status: 400,
      body: { error: "cwd must be an absolute path" },
    });
    expect(await post(host, "/api/children", { cwd: ws, sessionPath: "plan.jsonl" })).toMatchObject({
      status: 400,
      body: { error: "sessionPath must be an absolute path" },
    });
    expect(await get(host, "/api/nope")).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(await post(host, "/api/nope", { cwd: ws })).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(await childIds(host)).toEqual([]);
  });
});

describe("child creation", () => {
  test("a new child starts idle, unseen-free, and is listed", async () => {
    const host = makeHost(sb);
    const ws = sb.workspace("new");
    const res = await post(host, "/api/children", { cwd: ws });
    expect(res.status).toBe(201);
    const child = childOf(res.body);
    expect(child).toMatchObject({ cwd: ws, ring: "idle", level: "high", unseen: false });
    expect(await childIds(host)).toEqual([child.id]);
  });
});

describe("frame passthrough", () => {
  test("a socket to an unknown child is closed with 4004's reason", async () => {
    const host = makeHost(sb);
    const link = attach(host, "missing");
    await until(() => link.state === "closed", "close for unknown child");
    expect(link.reason).toBe("Unknown omp child");
  });

  test("a turn reaches the socket verbatim and settles the child", async () => {
    const host = makeHost(sb);
    const workspace = sb.workspace("turn");
    const { id, link } = await openAttached(host, workspace);

    const state = await call(host, id, link, { type: "get_state" });
    expect(state.success).toBe(true);
    expect(state.data.cwd).toBe(workspace);

    const res = await call(host, id, link, { type: "prompt", message: "quick", id: "p1" });
    expect(res).toMatchObject({ type: "response", command: "prompt", success: true });
    expect(link.frames).toContain(JSON.stringify({ type: "agent_start" }));
    await until(async () => (await statusOf(host, id)).ring === "idle", "ring idle after the turn");
    expect((await statusOf(host, id)).unseen).toBe(false);
  });

  test("an id-less prompt is given an id before it reaches the child", async () => {
    const host = makeHost(sb);
    const { id, link } = await openAttached(host, sb.workspace("anon"));
    sendFrame(host, id, { type: "prompt", message: "quick" });
    await until(() => frames(link).some((f) => f.type === "response" && f.command === "prompt"), "prompt response");

    const res = await call(host, id, link, { type: "get_log" });
    const prompt = res.data.commands.find((c: Frame) => c.type === "prompt");
    expect(String(prompt.id)).toMatch(/^prompt-/);
  });

  test("session-switching frames are refused locally and never reach the child", async () => {
    const host = makeHost(sb);
    const { id, link } = await openAttached(host, sb.workspace("refused"));
    for (const type of ["new_session", "switch_session", "open_session", "branch"]) {
      const res = await call(host, id, link, { type });
      expect(res).toMatchObject({
        type: "response",
        command: type,
        success: false,
        error: "Use /api/children to open a session",
      });
    }
    const types = await logTypes(host, id, link);
    for (const type of ["new_session", "switch_session", "open_session", "branch"]) expect(types).not.toContain(type);
  });

  test("a bridgeSnapshot flag is stripped before the command reaches the child", async () => {
    const host = makeHost(sb);
    const { id, link } = await openAttached(host, sb.workspace("strip"));
    await call(host, id, link, { type: "get_entries", bridgeSnapshot: true });
    const res = await call(host, id, link, { type: "get_log" });
    const entries = res.data.commands.filter((c: Frame) => c.type === "get_entries");
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("bridgeSnapshot");
  });

  test("malformed frames and frames without a string type are dropped, not forwarded", async () => {
    const host = makeHost(sb);
    const { id, link } = await openAttached(host, sb.workspace("malformed"));
    const before = await logTypes(host, id, link);

    host.frame(id, "{broken");
    sendFrame(host, id, { id: "no-type" });
    sendFrame(host, id, { type: 7 });

    expect(await logTypes(host, id, link)).toEqual([...before, "get_log"]);
  });

  test("non-JSON child output is dropped and the child keeps answering", async () => {
    const host = makeHost(sb);
    const { id, link } = await openAttached(host, sb.workspace("noise"));
    const res = await call(host, id, link, { type: "noise" });
    expect(res.success).toBe(true);
    expect(link.frames).not.toContain("not json");
    expect((await call(host, id, link, { type: "get_state" })).success).toBe(true);
  });
});

describe("bridge snapshot", () => {
  test("a snapshot carries ring, partial, dialogs and queue, then follows the dialog and the turn", async () => {
    const host = makeHost(sb);
    const { id, link } = await openAttached(host, sb.workspace("snap"));

    sendFrame(host, id, { type: "prompt", message: "hold", id: "p-hold" });
    await until(() => frames(link).some((f) => f.type === "message_start" && f.messageId === "m-p-hold"), "partial message");
    await call(host, id, link, { type: "ask" });

    const first = await call(host, id, link, { type: "get_entries", bridgeSnapshot: true });
    expect(first.success).toBe(true);
    const all = frames(link);
    const snapIndex = all.findIndex((f) => f.type === "bridge_snapshot");
    const respIndex = all.findIndex((f) => f.type === "response" && f.id === first.id);
    expect(snapIndex).toBeGreaterThanOrEqual(0);
    expect(snapIndex).toBeLessThan(respIndex);
    expect(all[snapIndex]).toEqual({
      type: "bridge_snapshot",
      ring: "work",
      level: "high",
      partial: all.find((f) => f.type === "message_start" && f.messageId === "m-p-hold"),
      dialogs: [all.find((f) => f.type === "extension_ui_request")],
      queue: all.find((f) => f.type === "queue_update"),
    });

    sendFrame(host, id, { type: "extension_ui_response", id: "ui-1", confirmed: true });
    await call(host, id, link, { type: "get_entries", bridgeSnapshot: true });
    expect(frames(link).filter((f) => f.type === "bridge_snapshot").at(-1)?.dialogs).toEqual([]);

    expect((await call(host, id, link, { type: "finish" })).success).toBe(true);
    await until(async () => (await statusOf(host, id)).ring === "idle", "ring idle after finish");
    await call(host, id, link, { type: "get_entries", bridgeSnapshot: true });
    const last = frames(link).filter((f) => f.type === "bridge_snapshot").at(-1);
    expect(last?.ring).toBe("idle");
    expect(last?.partial).toBeUndefined();
  });

  test("a failed snapshot request sends no bridge_snapshot", async () => {
    const host = makeHost(sb);
    const { id, link } = await openAttached(host, sb.workspace("badsnap"));
    const before = frames(link).filter((f) => f.type === "bridge_snapshot").length;
    const res = await call(host, id, link, { type: "get_entries", since: "bad", bridgeSnapshot: true });
    expect(res).toMatchObject({ success: false, error: "unknown_since" });
    expect(frames(link).filter((f) => f.type === "bridge_snapshot")).toHaveLength(before);
  });
});

describe("child limits", () => {
  test("at capacity with every child attached, a new child is refused with 409", async () => {
    const host = makeHost(sb, { childLimit: 2 });
    await openAttached(host, sb.workspace("one"));
    await openAttached(host, sb.workspace("two"));

    const res = await post(host, "/api/children", { cwd: sb.workspace("three") });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.stringMatching(/in use/) });
    expect(await childIds(host)).toHaveLength(2);
  });

  test("a detached idle child younger than the grace period is not evicted", async () => {
    const host = makeHost(sb, { childLimit: 2, attachGraceMs: 60_000 });
    await openChild(host, sb.workspace("young-a"));
    await openChild(host, sb.workspace("young-b"));

    const res = await post(host, "/api/children", { cwd: sb.workspace("young-c") });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.stringMatching(/in use/) });
    expect(await childIds(host)).toHaveLength(2);
  });

  test("at capacity, the oldest detached idle child past the grace period is evicted", async () => {
    const host = makeHost(sb, { childLimit: 2, attachGraceMs: 0 });
    const a = childOf((await openChild(host, sb.workspace("evict-a"))).body).id;
    const b = childOf((await openChild(host, sb.workspace("evict-b"))).body).id;

    const res = await openChild(host, sb.workspace("evict-c"));
    expect(res.status).toBe(201);
    const ids = await childIds(host);
    expect(ids).not.toContain(a);
    expect(ids).toContain(b);
    expect(ids).toContain(childOf(res.body).id);
  });

  test("a busy detached child is never evicted, and the idle one goes instead", async () => {
    const host = makeHost(sb, { childLimit: 2, attachGraceMs: 0 });
    const busy = await openAttached(host, sb.workspace("busy"));
    sendFrame(host, busy.id, { type: "prompt", message: "hold", id: "p-busy" });
    await until(() => frames(busy.link).some((f) => f.type === "agent_start"), "busy turn started");
    host.close(busy.id);

    const idle = childOf((await openChild(host, sb.workspace("idle-one"))).body).id;
    const res = await openChild(host, sb.workspace("newcomer"));
    expect(res.status).toBe(201);
    const ids = await childIds(host);
    expect(ids).toContain(busy.id);
    expect(ids).not.toContain(idle);
  });
});

describe("idle reap", () => {
  test("a detached idle child is reaped and its process exits", async () => {
    const host = makeHost(sb, { idleMs: 100, reapIntervalMs: 20 });
    const { id, link } = await openAttached(host, sb.workspace("reap"));
    const pid = (await call(host, id, link, { type: "get_state" })).data.pid;
    host.close(id);

    await until(async () => !(await childIds(host)).includes(id), "child reaped");
    await until(() => !alive(pid), "reaped process exit");
  });

  test("reap never touches an attached, busy, or dialog-holding child", async () => {
    const host = makeHost(sb, { idleMs: 100, reapIntervalMs: 20 });
    const attached = await openAttached(host, sb.workspace("keep-a"));

    const busy = await openAttached(host, sb.workspace("keep-b"));
    sendFrame(host, busy.id, { type: "prompt", message: "hold", id: "p-keep" });
    await until(() => frames(busy.link).some((f) => f.type === "agent_start"), "busy turn started");
    host.close(busy.id);

    const dialog = await openAttached(host, sb.workspace("keep-c"));
    await call(host, dialog.id, dialog.link, { type: "ask" });
    host.close(dialog.id);

    const control = childOf((await openChild(host, sb.workspace("keep-d"))).body).id;

    await until(async () => !(await childIds(host)).includes(control), "control child reaped");
    // Real timers: the reaper is a host setInterval and the children are real processes, so fake timers cannot drive it.
    // The sleep is a negative check; its lower bound (300 ms) exceeds idleMs (100) plus reapIntervalMs (20).
    await Bun.sleep(300);
    expect((await childIds(host)).sort()).toEqual([attached.id, busy.id, dialog.id].sort());
  });
});

describe("restart and recovery", () => {
  test("a session file opens in place, and reopening it returns the live child", async () => {
    const ws = sb.workspace("proj");
    const plan = sb.session("proj-dir", "plan.jsonl", [header("s-plan", ws), titleLine("Plan")], 1000);
    const host = makeHost(sb);

    const first = await openChild(host, ws, plan);
    expect(first.status).toBe(200);
    const child = childOf(first.body);
    expect(child).toMatchObject({ sessionPath: plan, title: "Plan" });

    const again = await openChild(host, ws, plan);
    expect(again.status).toBe(200);
    expect(childOf(again.body).id).toBe(child.id);

    const other = sb.session("proj-dir", "other.jsonl", [header("s-other", ws), titleLine("Other")], 1000);
    const [x, y] = await Promise.all([openChild(host, ws, other), openChild(host, ws, other)]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(childOf(x.body).id).toBe(childOf(y.body).id);
  });

  test("a crashed child reports bridge_exit, closes its sockets and leaves the list; its session survives", async () => {
    const ws = sb.workspace("crash");
    const plan = sb.session("crash-dir", "plan.jsonl", [header("s-plan", ws), titleLine("Plan")], 1000);
    const host = makeHost(sb);
    const created = childOf((await openChild(host, ws, plan)).body);
    const link = attach(host, created.id);
    await until(() => link.state === "open", "socket open");

    sendFrame(host, created.id, { type: "crash" });
    await until(() => link.state === "closed", "socket closed after crash");
    expect(link.reason).toBe("omp exited");
    expect(frames(link).find((f) => f.type === "bridge_exit")).toEqual({ type: "bridge_exit", exitCode: 3 });
    expect(await childIds(host)).not.toContain(created.id);
    expect(fs.existsSync(plan)).toBe(true);

    const reopened = await openChild(host, ws, plan);
    expect(reopened.status).toBe(200);
    const child = childOf(reopened.body);
    expect(child.id).not.toBe(created.id);
    expect(child).toMatchObject({ sessionPath: plan, title: "Plan" });

    const link2 = attach(host, child.id);
    await until(() => link2.state === "open", "socket open after reopen");
    const state = await call(host, child.id, link2, { type: "get_state" });
    expect(state.data.sessionFile).toBe(plan);
  });

  test("a refused session switch leaves no child behind", async () => {
    const ws = sb.workspace("refuse");
    const refuse = sb.session("refuse-dir", "refuse.jsonl", [header("s-refuse", ws), titleLine("No")], 1000);
    const host = makeHost(sb);
    const res = await openChild(host, ws, refuse);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.stringMatching(/cancel/i) });
    expect(await childIds(host)).toEqual([]);
  });
});

describe("shutdown", () => {
  test("shutdown kills every child and closes every socket", async () => {
    const host = makeHost(sb);
    const one = await openAttached(host, sb.workspace("down-a"));
    const two = await openAttached(host, sb.workspace("down-b"));
    const pids: number[] = [
      (await call(host, one.id, one.link, { type: "get_state" })).data.pid,
      (await call(host, two.id, two.link, { type: "get_state" })).data.pid,
    ];

    await retire(host);
    for (const pid of pids) await until(() => !alive(pid), `pid ${pid} exit`);
    await until(() => one.link.state === "closed" && two.link.state === "closed", "sockets closed");
  });
});
