import { afterEach, expect, test } from "bun:test";
import { CGSCONNECT_ORIGIN, createConnect } from "../../src/index.ts";
import { divert } from "../../../../plugin/omp-extension/index.ts";

const claudeKey = "sk-ant-oat01-1";
let undo = () => {};
afterEach(() => undo());

test("provider traffic addressed to the virtual origin leaves through the router to the API server; other fetches are untouched", async () => {
  const sent: { url: string; auth: string | null }[] = [];
  const connect = createConnect({
    upstream: "https://api.example",
    directFetch: async (r) => { sent.push({ url: r.url, auth: r.headers.get("authorization") }); return new Response("ok"); },
  });
  connect.hub.pushCredentials([{ provider: "cgs-claude", id: "s1", key: claudeKey }]);
  const other = globalThis.fetch;
  undo = divert((i, init) => connect.fetch(new Request(i, init)));
  try {
    const res = await fetch(`${CGSCONNECT_ORIGIN}/v1/messages`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${claudeKey}` } });
    expect(await res.text()).toBe("ok");
    expect(sent).toEqual([{ url: "https://api.example/v1/messages", auth: `Bearer ${claudeKey}` }]);
    // not addressed to cgsconnect: must not reach the router
    const echo = Bun.serve({ port: 0, fetch: () => new Response("plain") });
    try { expect(await (await fetch(`http://127.0.0.1:${echo.port}/`)).text()).toBe("plain"); } finally { echo.stop(true); }
    expect(sent).toHaveLength(1);
  } finally { undo(); connect.stop(); }
  expect(globalThis.fetch).toBe(other);
});

test("router control endpoints are reachable through the same direct call", async () => {
  const connect = createConnect({ upstream: "https://api.example" });
  try {
    const res = await connect.fetch(new Request(`${CGSCONNECT_ORIGIN}/_cgs-agent/v1/status`));
    expect(res.status).toBe(200);
  } finally { connect.stop(); }
});
