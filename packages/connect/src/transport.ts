import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex, Msg } from "@cgscli/wire";

// Local transport (ADR 0017): a unix socket, or a named pipe on Windows. One JSON message per line;
// JSON.stringify never emits a raw newline, so the framing needs no escaping.

export interface Listener { address: string; stop(): void }

/** Default endpoint: per-user, not shared. `CGSCONNECT_SOCKET` overrides it. */
export function defaultEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const o = env.CGSCONNECT_SOCKET?.trim();
  if (o) return o;
  if (process.platform === "win32") return `\\\\.\\pipe\\cgsconnect-${os.userInfo().username}`;
  const base = env.XDG_RUNTIME_DIR?.trim() || path.join(os.tmpdir(), `cgs-${os.userInfo().uid}`);
  return path.join(base, "cgsconnect", "connect.sock");
}

export function fromSocket(sock: net.Socket): Duplex {
  const msgs: ((m: Msg) => void)[] = [];
  const closes: ((e?: Error) => void)[] = [];
  let buf = "";
  let done = false;
  const finish = (e?: Error) => { if (done) return; done = true; closes.forEach((f) => f(e)); };
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m: Msg;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && typeof m.t === "string") msgs.forEach((f) => f(m));
    }
  });
  sock.on("close", () => finish());
  sock.on("error", (e) => finish(e));
  return {
    send: (m) => { if (done) throw new Error("closed"); sock.write(JSON.stringify(m) + "\n"); },
    onMessage: (cb) => void msgs.push(cb),
    onClose: (cb) => void closes.push(cb),
    close: () => void sock.end(),
  };
}

export function dial(endpoint: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s = net.connect(endpoint);
    s.once("error", reject);
    s.once("connect", () => { s.off("error", reject); resolve(fromSocket(s)); });
  });
}

/** True when something accepts connections at `endpoint`. */
function alive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(endpoint);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

/** Listens on `endpoint` and hands each connection to `onChannel`. Refuses to take over a live daemon's endpoint. */
export async function listen(endpoint: string, onChannel: (d: Duplex) => void): Promise<Listener> {
  const pipe = process.platform === "win32";
  if (!pipe) {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    if (fs.existsSync(endpoint)) {
      if (await alive(endpoint)) throw new Error(`cgsconnect is already running at ${endpoint}`);
      fs.unlinkSync(endpoint); // stale socket from a crashed daemon
    }
  }
  const socks = new Set<net.Socket>();
  const srv = net.createServer((s) => { socks.add(s); s.on("close", () => socks.delete(s)); onChannel(fromSocket(s)); });
  await new Promise<void>((resolve, reject) => {
    srv.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE" ? new Error(`cgsconnect is already running at ${endpoint}`) : e));
    srv.listen(endpoint, resolve);
  });
  // The directory is 0700; tighten the socket as well so a permissive umask cannot widen access.
  if (!pipe) fs.chmodSync(endpoint, 0o600);
  return {
    address: endpoint,
    stop: () => { srv.close(); socks.forEach((s) => s.destroy()); if (!pipe) fs.rmSync(endpoint, { force: true }); },
  };
}
