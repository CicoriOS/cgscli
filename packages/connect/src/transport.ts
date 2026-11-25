import { fromWebSocket, type Duplex, type WebSocketLike } from "@cgscli/wire";
import type { TransportOption } from "./contracts.ts";

export interface Listener { address: string; stop(): void }

type Handler = (e: { data?: unknown }) => void;
interface WsData { message: Handler[]; close: Handler[] }

/** Listens on the caller-chosen transport (O3) and hands each WebSocket to `onChannel` as a Duplex. */
export function listen(t: TransportOption, onChannel: (d: Duplex) => void): Listener {
  if (t.kind === "unix" && process.platform === "win32") throw new Error("named-pipe transport not implemented (O3/V1)");
  const websocket: Bun.WebSocketHandler<WsData> = {
    open(ws) {
      const like: WebSocketLike = {
        send: (d) => void ws.send(d),
        close: () => ws.close(),
        addEventListener(type: string, cb: Handler) {
          if (type === "message") ws.data.message.push(cb);
          else ws.data.close.push(cb);
        },
      };
      onChannel(fromWebSocket(like));
    },
    message(ws, data) {
      const text = typeof data === "string" ? data : data.toString();
      for (const f of ws.data.message) f({ data: text });
    },
    close(ws) { for (const f of ws.data.close) f({}); },
  };
  const fetch = (req: Request, srv: Bun.Server<WsData>) =>
    srv.upgrade(req, { data: { message: [], close: [] } }) ? undefined : new Response("websocket only", { status: 426 });
  if (t.kind === "unix") {
    const s = Bun.serve<WsData>({ unix: t.path, fetch, websocket });
    return { address: `unix:${t.path}`, stop: () => void s.stop(true) };
  }
  const s = Bun.serve<WsData>({ hostname: "127.0.0.1", port: t.port ?? 0, fetch, websocket });
  return { address: `ws://127.0.0.1:${s.port}`, stop: () => void s.stop(true) };
}
