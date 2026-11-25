import type { Duplex, Msg } from "./protocol.ts";

interface Endpoint { msg: ((m: Msg) => void)[]; close: ((e?: Error) => void)[]; closed: boolean }

/** In-process pair; delivery is asynchronous (microtask) like a real channel. */
export function memoryPair(): [Duplex, Duplex] {
  const mk = (): Endpoint => ({ msg: [], close: [], closed: false });
  const a = mk(), b = mk();
  const end = (self: Endpoint, peer: Endpoint): Duplex => ({
    send(m) { if (self.closed) throw new Error("closed"); const c = structuredClone(m); queueMicrotask(() => peer.msg.forEach((f) => f(c))); },
    onMessage(cb) { self.msg.push(cb); },
    onClose(cb) { self.close.push(cb); },
    close() {
      if (self.closed) return;
      self.closed = peer.closed = true;
      queueMicrotask(() => { self.close.forEach((f) => f()); peer.close.forEach((f) => f()); });
    },
  });
  return [end(a, b), end(b, a)];
}

/** Minimal WebSocket shape (browser, Bun, or `ws`). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", cb: (e: unknown) => void): void;
}

export function fromWebSocket(ws: WebSocketLike): Duplex {
  return {
    send: (m) => ws.send(JSON.stringify(m)),
    onMessage(cb) {
      ws.addEventListener("message", (e) => {
        if (typeof e.data !== "string") return;
        let m: Msg;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m && typeof m.t === "string") cb(m);
      });
    },
    onClose(cb) { ws.addEventListener("close", () => cb()); ws.addEventListener("error", (e) => cb(e instanceof Error ? e : new Error("ws error"))); },
    close: () => ws.close(),
  };
}
