import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createComponentManager, download, HashMismatch, parseComponentsLock, type ComponentsLock } from "../../src/components/index.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const dirs: string[] = [];
const servers: { stop(f?: boolean): void }[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-comp-")); dirs.push(d); return d; };
afterEach(() => { servers.splice(0).forEach((s) => s.stop(true)); dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })); });

const entry = (over: object = {}) => ({ id: "tool", version: "1", platform: "linux-x64", url: ["https://x.test/a"], sha256: "a".repeat(64), size: 1, ...over });

test("components.lock validation rejects unsafe or malformed entries", () => {
  expect(parseComponentsLock(JSON.stringify({ components: [entry()] })).components).toHaveLength(1);
  const bad = (over: object) => () => parseComponentsLock(JSON.stringify({ components: [entry(over)] }));
  expect(bad({ sha256: "xyz" })).toThrow("sha256");
  expect(bad({ url: ["http://insecure"] })).toThrow("https");
  expect(bad({ platform: "mac" })).toThrow("platform");
  expect(bad({ bin: { x: "../../etc/passwd" } })).toThrow("unsafe");
  expect(() => parseComponentsLock(JSON.stringify({ components: [entry(), entry()] }))).toThrow("duplicate");
});

// Server that cuts the first response short, then honours Range.
function flakyServer(body: Uint8Array) {
  let calls = 0;
  const ranges: (string | null)[] = [];
  // Raw HTTP/1.1: Bun's own server drops an explicit Content-Length on streamed bodies, so truncation would look complete.
  const s = net.createServer((sock) => {
    sock.once("data", (req) => {
      calls++;
      const range = /^range: bytes=(\d+)-/im.exec(req.toString());
      ranges.push(range ? `bytes=${range[1]}-` : null);
      const from = range ? Number(range[1]) : 0;
      const rest = body.subarray(from);
      const head = `HTTP/1.1 ${from ? "206 Partial Content" : "200 OK"}\r\ncontent-length: ${rest.length}\r\nconnection: close\r\n\r\n`;
      sock.write(head);
      if (calls === 1) {
        // 20 separate writes, then a clean FIN: the client has consumed data before it notices the short body.
        const part = rest.subarray(0, Math.floor(rest.length / 2));
        const step = Math.ceil(part.length / 20);
        const send = (o: number) => { if (o >= part.length) return void sock.end(); sock.write(part.subarray(o, o + step), () => setImmediate(() => send(o + step))); };
        send(0);
        return;
      }
      sock.end(rest);
    });
    sock.on("error", () => {});
  });
  s.listen(0);
  servers.push({ stop: () => void s.close() });
  return { url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}/f`, ranges };
}

test("download resumes a cut transfer with Range and verifies SHA256", async () => {
  const body = new Uint8Array(200_000).map((_, i) => i % 251);
  const f = flakyServer(body);
  const dest = path.join(tmp(), "out.bin");
  await download({ urls: [f.url], dest, sha256: sha(body) });
  expect(sha(fs.readFileSync(dest))).toBe(sha(body));
  expect(f.ranges[0]).toBeNull();
  expect(f.ranges[1]).toMatch(/^bytes=[1-9]\d*-$/);
});

test("a hash mismatch deletes the data and moves on to the next URL", async () => {
  const good = new TextEncoder().encode("good");
  const bad = Bun.serve({ port: 0, fetch: () => new Response("evil") });
  const ok = Bun.serve({ port: 0, fetch: () => new Response(good) });
  servers.push(bad, ok);
  const dest = path.join(tmp(), "o");
  await download({ urls: [`http://127.0.0.1:${bad.port}/`, `http://127.0.0.1:${ok.port}/`], dest, sha256: sha(good) });
  expect(fs.readFileSync(dest, "utf8")).toBe("good");
  expect(fs.existsSync(`${dest}.part`)).toBe(false);
  await expect(download({ urls: [`http://127.0.0.1:${bad.port}/`], dest: path.join(tmp(), "p"), sha256: sha(good) })).rejects.toBeInstanceOf(HashMismatch);
});

test("manager installs a tar component, resolves binaries, injects PATH dirs, and doctor reports drift", async () => {
  const work = tmp();
  fs.mkdirSync(path.join(work, "src/bin"), { recursive: true });
  fs.writeFileSync(path.join(work, "src/bin/clangd"), "#!/bin/sh\n");
  const tarball = path.join(work, "t.tar");
  spawnSync("tar", ["-cf", tarball, "-C", path.join(work, "src"), "bin"]);
  const bytes = fs.readFileSync(tarball);
  const srv = Bun.serve({ port: 0, fetch: () => new Response(bytes) });
  servers.push(srv);
  const lock: ComponentsLock = { components: [{ id: "llvm", version: "20", platform: "linux-x64", url: [`http://127.0.0.1:${srv.port}/llvm.tar`], sha256: sha(bytes), size: bytes.length, bin: { clangd: "bin/clangd" }, pathDirs: ["bin"] }] };
  const root = path.join(work, "root");
  const m = createComponentManager({ lock, root, platform: "linux-x64" });

  expect((await m.doctor()).items[0]).toMatchObject({ name: "llvm", status: "missing" });
  expect(await m.resolve("clangd")).toBeNull();
  await m.install("llvm");
  expect(await m.resolve("clangd")).toBe(path.join(root, "llvm/20/bin/clangd"));
  expect(m.envPath()).toEqual([path.join(root, "llvm/20/bin")]);
  expect((await m.doctor()).ok).toBe(true);

  fs.rmSync(path.join(root, "llvm/20/bin/clangd"));
  expect((await m.doctor()).items[0]).toMatchObject({ status: "mismatch", detail: "missing executables: clangd" });

  const bumped = createComponentManager({ lock: { components: [{ ...lock.components[0]!, version: "21", sha256: "b".repeat(64) }] }, root, platform: "linux-x64" });
  expect((await bumped.doctor()).items[0]!.status).toBe("missing");
  await expect(m.install("nope")).rejects.toThrow("not in components.lock");
});
