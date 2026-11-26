// Fake `omp --mode rpc-ui` for the host tests. It speaks only the JSONL surface the host relies on, and it
// scripts its turns from the prompt text so every behavior is deterministic:
//   "quick"  acknowledges, then settles at once
//   "later"  settles 30 ms after it starts
//   "hold"   stays busy (with a partial assistant message and a queue update) until `finish`
// Other commands: get_state, switch_session (refuses paths containing "refuse"), get_entries (fails for
// since "bad"), set_thinking_level, ask (raises a confirm dialog), extension_ui_response (no reply, as omp),
// get_log (every command received so far), noise (a non-JSON stdout line), crash (exits with code 3 at once).
// Output goes through writeSync, so each line is written before any exit.
import fs from "node:fs";
import readline from "node:readline";

type Cmd = { type: string; id?: string; [key: string]: unknown };
interface Turn { id: string; text: string; acked: boolean }

const received: Cmd[] = [];
let sessionFile: string | undefined;
let thinking = "high";
let active: Turn | undefined;

const write = (frame: Record<string, unknown>): void => {
  fs.writeSync(1, `${JSON.stringify(frame)}\n`);
};
const ok = (cmd: Cmd, data?: unknown): void => write({ type: "response", command: cmd.type, id: cmd.id, success: true, data });
const fail = (cmd: Cmd, error: string): void => write({ type: "response", command: cmd.type, id: cmd.id, success: false, error });

function begin(turn: Turn): void {
  active = turn;
  write({ type: "agent_start" });
  write({ type: "message_start", message: { role: "user", content: [{ type: "text", text: turn.text }] } });
  write({ type: "queue_update", steering: [], followUp: [] });
}

function settle(turn: Turn): void {
  if (active !== turn) return;
  active = undefined;
  if (!turn.acked) {
    turn.acked = true;
    write({ type: "response", command: "prompt", id: turn.id, success: true });
  }
  write({ type: "message_end", messageId: `m-${turn.id}` });
  write({ type: "agent_end", messages: [] });
  write({ type: "session_settled" });
}

function handle(cmd: Cmd): void {
  received.push(cmd);
  switch (cmd.type) {
    case "get_state":
      return ok(cmd, {
        cwd: process.cwd(),
        pid: process.pid,
        sessionFile,
        thinkingLevel: thinking,
        isStreaming: active !== undefined,
        isSettled: active === undefined,
      });
    case "switch_session": {
      const file = String(cmd.sessionPath);
      if (file.includes("refuse")) return ok(cmd, { cancelled: true });
      sessionFile = file;
      return ok(cmd, { cancelled: false });
    }
    case "get_entries":
      if (cmd.since === "bad") return fail(cmd, "unknown_since");
      return ok(cmd, { entries: [] });
    case "get_log":
      return ok(cmd, { commands: received.slice() });
    case "set_thinking_level":
      thinking = String(cmd.level);
      write({ type: "thinking_level_changed", resolved: thinking });
      return ok(cmd);
    case "prompt": {
      if (active) return fail(cmd, "busy");
      const turn: Turn = { id: String(cmd.id), text: String(cmd.message), acked: false };
      begin(turn);
      if (turn.text === "quick") return settle(turn);
      if (turn.text === "later") {
        setTimeout(() => settle(turn), 30);
        return;
      }
      write({
        type: "message_start",
        messageId: `m-${turn.id}`,
        message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
      });
      return;
    }
    case "finish":
      if (!active) return fail(cmd, "nothing to finish");
      settle(active);
      return ok(cmd);
    case "ask":
      write({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Confirm", message: "Proceed?" });
      return ok(cmd);
    case "extension_ui_response":
      return;
    case "noise":
      fs.writeSync(1, "not json\n");
      return ok(cmd);
    case "crash":
      process.exit(3);
    default:
      return fail(cmd, `unknown command ${cmd.type}`);
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd: Cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  handle(cmd);
});
