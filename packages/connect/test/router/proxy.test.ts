import { expect, test } from "bun:test";
import { proxyFor } from "../../src/router/proxy.ts";

const at = (url: string, env: Record<string, string>) => proxyFor(new URL(url), env);

test("https and wss use HTTPS_PROXY, http and ws use HTTP_PROXY, ALL_PROXY is the fallback, lower case works", () => {
  const env = { HTTPS_PROXY: "http://s:1", HTTP_PROXY: "http://p:2", ALL_PROXY: "http://all:3" };
  expect(at("https://a.example", env)).toBe("http://s:1");
  expect(at("wss://a.example", env)).toBe("http://s:1");
  expect(at("http://a.example", env)).toBe("http://p:2");
  expect(at("https://a.example", { ALL_PROXY: "http://all:3" })).toBe("http://all:3");
  expect(at("http://a.example", { http_proxy: "http://low:4" })).toBe("http://low:4");
  expect(at("https://a.example", {})).toBeUndefined();
});

test("PI_PROXY is not read, a scheme-less value means http, an unsupported scheme means no proxy", () => {
  expect(at("https://a.example", { PI_PROXY: "http://pi:1", PI_PROXY_CGS: "http://pi:2" })).toBeUndefined();
  expect(at("https://a.example", { HTTPS_PROXY: "127.0.0.1:7890" })).toBe("http://127.0.0.1:7890");
  expect(at("https://a.example", { HTTPS_PROXY: "socks5://127.0.0.1:1080" })).toBeUndefined();
});

test("loopback always connects directly; NO_PROXY takes *, exact hosts, domain suffixes and ports", () => {
  const env = { HTTPS_PROXY: "http://s:1", HTTP_PROXY: "http://s:1" };
  for (const u of ["http://localhost:80", "http://127.0.0.1:9", "http://[::1]:9"]) expect(at(u, env)).toBeUndefined();
  expect(at("https://a.example", { ...env, NO_PROXY: "*" })).toBeUndefined();
  expect(at("https://a.example", { ...env, NO_PROXY: "other.test, a.example" })).toBeUndefined();
  expect(at("https://x.a.example", { ...env, NO_PROXY: ".a.example" })).toBeUndefined();
  expect(at("https://xa.example", { ...env, NO_PROXY: "a.example" })).toBe("http://s:1");
  expect(at("https://a.example:8443", { ...env, NO_PROXY: "a.example:443" })).toBe("http://s:1");
  expect(at("https://a.example", { ...env, no_proxy: "a.example:443" })).toBeUndefined();
});
