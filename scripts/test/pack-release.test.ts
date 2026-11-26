import { expect, test } from "bun:test";
import { bundleDependencies, setBundleVersion } from "../pack-release.ts";

const manifest = {
  version: "19.2.1",
  files: ["dist/cli.js"],
  engines: { bun: ">=1.4.4" },
  dependencies: {
    "@oh-my-pi/pi-natives": "catalog:",
    "@babel/parser": "catalog:",
    "puppeteer-core": "catalog:",
    "@oh-my-pi/pi-utils": "catalog:",
  },
};

test("release dependencies include only imported externals at their checkout pins", () => {
  const source = `import "node:fs";
    import "./defaults.json-12345678.zst";
    import "@oh-my-pi/pi-natives/path";
    import "@oh-my-pi/pi-natives";
    export const browser = () => import("puppeteer-core/internal/revisions.js");
    export const parser = () => import("@babel/parser");`;
  const catalog = {
    "@oh-my-pi/pi-natives": "19.2.1",
    "@babel/parser": "^7.29.7",
    "puppeteer-core": "25.3.0",
    "@oh-my-pi/pi-utils": "19.2.1",
  };
  const lock = {
    "@oh-my-pi/pi-natives": ["@oh-my-pi/pi-natives@workspace:packages/natives"],
    "@babel/parser": ["@babel/parser@7.29.9"],
    "puppeteer-core": ["puppeteer-core@25.3.0"],
    "@oh-my-pi/pi-utils": ["@oh-my-pi/pi-utils@workspace:packages/utils"],
  } as const;
  expect(bundleDependencies(source, manifest, catalog, lock)).toEqual({
    "@babel/parser": "7.29.9",
    "@oh-my-pi/pi-natives": "19.2.1",
    "puppeteer-core": "25.3.0",
  });
  expect(() => bundleDependencies('import "unlocked";', manifest, catalog, lock)).toThrow("No exact omp runtime dependency version for unlocked");
});

test("release VERSION changes without changing stock workspace metadata", () => {
  const bundled = 'var $v="19.2.1",engines;var metadata={version:"19.2.1"};a=[],version=$v,ua=`omp/${version}`;';
  expect(setBundleVersion(bundled, "19.2.1", "19.2.1-cgs.3"))
    .toBe('var $v="19.2.1",engines;var metadata={version:"19.2.1"};a=[],version="19.2.1-cgs.3",ua=`omp/${version}`;');
  expect(() => setBundleVersion(bundled, "19.2.2", "19.2.2-cgs.1")).toThrow("omp VERSION is not the expected 19.2.2");
});
