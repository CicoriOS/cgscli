// DEV / TEST relay only. This is a reference for the relay protocol in packages/connect/src/remote/envelope.ts, used to
// try the cli-to-cli remote link on one machine or a LAN. It is NOT the production relay: no accounts, no rate limits,
// no TLS. It routes opaque envelopes between one device and its clients by `sid` and never sees plaintext.
//
//   bun scripts/dev-relay.ts [port]        (default 8799; prints the URL to use as CGS_RELAY_URL)
import { parseEnvelope } from "../packages/connect/src/remote/envelope.ts";

type Data = { kind: "device" | "client"; device: string; sid?: string };

export interface DevRelay { url: string; stop(): void }

export function startDevRelay(port = 0, host = "127.0.0.1"): DevRelay {
  const devices = new Map<string, Bun.ServerWebSocket<Data>>();
  const clients = new Map<string, Bun.ServerWebSocket<Data>>();
  let n = 0;
  const srv = Bun.serve<Data>({
    hostname: host,
    port,
    fetch(req, s) {
      const u = new URL(req.url);
      const device = u.searchParams.get("device") ?? "";
      if (u.pathname === "/api/devices") return req.method === "POST" ? Response.json({ success: true }) : Response.json([...devices.keys()].map((id) => ({ id, name: id, online: true })));
      if (u.pathname === "/api/relay/device" && device) return s.upgrade(req, { data: { kind: "device", device } }) ? undefined : new Response("upgrade failed", { status: 400 });
      if (u.pathname === "/api/relay/client" && device) return s.upgrade(req, { data: { kind: "client", device, sid: `c${++n}` } }) ? undefined : new Response("upgrade failed", { status: 400 });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "device") { devices.set(ws.data.device, ws); return; }
        const dev = devices.get(ws.data.device);
        const sid = ws.data.sid!;
        if (!dev) { ws.send(JSON.stringify({ v: 1, type: "ctl", sid, seq: 0, payload: { op: "error", code: "device-offline" } })); ws.close(); return; }
        clients.set(sid, ws);
        const open = JSON.stringify({ v: 1, type: "ctl", sid, seq: 0, payload: { op: "open" } });
        ws.send(open);
        dev.send(open);
      },
      message(ws, data) {
        const text = String(data);
        const env = parseEnvelope(text);
        if (!env) return;
        if (ws.data.kind === "device") clients.get(env.sid)?.send(text);
        else if (env.sid === ws.data.sid) devices.get(ws.data.device)?.send(text); // a client can only speak on its own sid
      },
      close(ws) {
        if (ws.data.kind === "device") { if (devices.get(ws.data.device) === ws) devices.delete(ws.data.device); return; }
        const sid = ws.data.sid!;
        clients.delete(sid);
        devices.get(ws.data.device)?.send(JSON.stringify({ v: 1, type: "ctl", sid, seq: 0, payload: { op: "close" } }));
      },
    },
  });
  return { url: `ws://${host}:${srv.port}`, stop: () => void srv.stop(true) };
}

if (import.meta.main) {
  const r = startDevRelay(Number(process.argv[2] ?? 8799), process.env.HOST ?? "127.0.0.1");
  console.log(`dev relay (not for production) on ${r.url}\nexport CGS_RELAY_URL=${r.url}`);
}
