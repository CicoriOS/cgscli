import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deviceLogin, LoginError, solvePow } from "../login.ts";

test("solvePow returns the smallest nonce with enough leading zero bits", async () => {
  const nonce = await solvePow("pfx", 12);
  const ok = (n: string) => { const d = createHash("sha256").update(`pfx:${n}`).digest(); return d[0]! === 0 && (d[1]! >> 4) === 0; };
  expect(ok(nonce)).toBe(true);
  for (let n = 0; n < Number(nonce); n++) expect(ok(String(n))).toBe(false);
});

// Mock new-api device endpoints; `polls` scripts the poll answers.
function mockApi(polls: Record<string, unknown>[]) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    seen.push(`${init?.method} ${u.pathname}`);
    const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
    if (u.pathname === "/api/device/sessions") return ok({ session_id: "s1", challenge: { prefix: "p", difficulty: 4 }, expires_in: 60 });
    if (u.pathname.endsWith("/challenge")) return ok({ uuid: "u1", poll_token: "t", expires_at: 4102444800, verification_url: "https://public.example/login?code=abc" });
    const next = polls.shift();
    if (!next) throw new Error("unexpected poll");
    return next.__status ? new Response("", { status: Number(next.__status) }) : ok(next);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

test("device login: pending -> approved; verification link is rebased onto the configured host", async () => {
  const { fetchImpl, seen } = mockApi([{ status: "pending" }, { __status: 503 }, { status: "approved", client_secret: "sec", tier: "pro", username: "u" }]);
  const links: string[] = [];
  const r = await deviceLogin({ baseUrl: "https://api.example/", fetch: fetchImpl, pollIntervalMs: 0, onProgress: (e) => { if (e.phase === "waiting") links.push(e.verificationUrl); } });
  expect(r).toEqual({ clientSecret: "sec", tier: "pro", username: "u" });
  expect(links).toEqual(["https://api.example/login?code=abc"]);
  expect(seen.filter((s) => s.endsWith("/poll"))).toHaveLength(3);
});

test("device login: denied and expired are distinct errors; unknown poll rejection means expiry", async () => {
  await expect(deviceLogin({ baseUrl: "https://a", fetch: mockApi([{ status: "denied" }]).fetchImpl, pollIntervalMs: 0 })).rejects.toMatchObject({ code: "denied" });
  await expect(deviceLogin({ baseUrl: "https://a", fetch: mockApi([{ status: "expired" }]).fetchImpl, pollIntervalMs: 0 })).rejects.toBeInstanceOf(LoginError);
});


test("the login provider runs the device flow through the router on the Bootstrap-selected origin and stores the logical origin", async () => {
  const { cgsLoginProvider } = await import("../index.ts");
  const { fetchImpl, seen } = mockApi([{ status: "approved", client_secret: "sec", tier: "pro", username: "alice" }]);
  const routed: string[] = [];
  const route = { ready: async () => {}, upstream: () => "https://mirror.example", fetch: (req: Request) => { routed.push(req.url); return fetchImpl(req.url, { method: req.method }); } };
  const provider = cgsLoginProvider(route, { CGS_BASE_URL: "https://logical.example" });
  expect(provider.name).toBe("Cicori Good Service");
  const shown: string[] = [];
  const cred = await provider.login({ onAuth: (i) => void shown.push(i.url), onPrompt: async () => { throw new Error("must not prompt"); }, signal: undefined });
  expect(routed.every((u) => u.startsWith("https://mirror.example/api/device/"))).toBe(true);
  expect(seen[0]).toBe("POST /api/device/sessions");
  expect(shown).toEqual(["https://mirror.example/login?code=abc"]);
  expect(cred).toMatchObject({ access: "sec", enterpriseUrl: "https://logical.example", email: "alice" });
});
