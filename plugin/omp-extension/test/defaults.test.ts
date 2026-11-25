import { expect, test } from "bun:test";
import { DEFAULT_CANDIDATES, candidatesFrom, logicalOrigin } from "../defaults.ts";

test("default candidates fall back ai.cicori.com -> apia.bmpss.top -> ai.cnklp.cn; ai.tmp.cnklp.cn is retired", () => {
  expect(candidatesFrom({})).toEqual(["https://ai.cicori.com", "https://apia.bmpss.top", "https://ai.cnklp.cn"]);
  expect(DEFAULT_CANDIDATES.some((c) => c.includes("tmp.cnklp"))).toBe(false);
});

test("CGS_BASE_URL replaces the candidate list entirely", () => {
  expect(candidatesFrom({ CGS_BASE_URL: " http://127.0.0.1:8787/ " })).toEqual(["http://127.0.0.1:8787"]);
  expect(logicalOrigin({ CGS_BASE_URL: "http://127.0.0.1:8787" })).toBe("http://127.0.0.1:8787");
  expect(logicalOrigin({})).toBe("https://ai.cicori.com");
});
