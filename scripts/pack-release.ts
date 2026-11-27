#!/usr/bin/env bun
// Usage: bun scripts/pack-release.ts [n] [--omp-dir DIR] [--out-dir DIR]
// Run after omp's gen:bundle. Writes cicori-cgs-<omp version>-cgs.<n>.tgz, the tarball published to npm as @cicori/cgs.
// <n> is `N` (a release) or `N.M` (a fix to release N; ADR 0044). Never choose a new N yourself: only the owner raises it.
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import template from "./release-package.json";

const root = path.resolve(import.meta.dir, "..");
const js = new Bun.Transpiler({ loader: "js" });
const ts = new Bun.Transpiler({ loader: "ts" });
const identifier = String.raw`[$\w]+`;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

type Manifest = {
  version: string;
  files: string[];
  engines: Record<string, string>;
  dependencies: Record<string, string>;
};
type LockEntry = readonly [string, ...unknown[]];

export function bundleDependencies(bundle: string, manifest: Manifest, catalog: Record<string, string>, locked: Record<string, LockEntry>) {
  const names = new Set(js.scan(bundle).imports.map(({ path: specifier }) => specifier)
    .filter((s) => !s.startsWith(".") && !path.isAbsolute(s) && !isBuiltin(s))
    .map(nameOf));
  return Object.fromEntries([...names].sort().map((name) => {
    const spec = manifest.dependencies[name];
    const declared = spec === "catalog:" ? catalog[name] : spec;
    // A workspace link in omp's lock corresponds to the stock npm package at the catalog pin.
    const resolved = (locked[`packages/coding-agent/${name}`] ?? locked[name])?.[0];
    const pinned = resolved?.slice(name.length + 1);
    const version = pinned?.startsWith("workspace:") ? declared : pinned;
    if (!declared || !version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
      throw new Error(`No exact omp runtime dependency version for ${name}`);
    }
    return [name, version];
  }));
}

export function setBundleVersion(bundle: string, ompVersion: string, cgsVersion: string): string {
  // utils/src/dirs.ts imports its workspace package.json, so Bun inlines VERSION.
  // Identify the binding by its use in USER_AGENT, not by globally replacing the
  // omp version (which also appears in the native/add-on and workspace metadata).
  const uses = [...bundle.matchAll(new RegExp(`(?<![$\\w])(${identifier})=(${identifier}),${identifier}=\u0060omp/\\$\\{\\1\\}\u0060`, "g"))];
  const use = uses[0];
  const binding = use?.[2];
  if (uses.length !== 1 || !binding) throw new Error("Could not locate omp VERSION/USER_AGENT in dist/cli.js; check utils/src/dirs.ts and the bundle output");
  const definitions = [...bundle.matchAll(new RegExp(`\\b(?:var|let|const) ${escapeRegex(binding)}=${escapeRegex(JSON.stringify(ompVersion))}(?=[,;])`, "g"))];
  if (definitions.length !== 1 || use.index === undefined) throw new Error(`omp VERSION is not the expected ${ompVersion}; check the bundle against the checkout`);
  const assignment = `${use[1]}=${binding}`;
  return bundle.slice(0, use.index) + `${use[1]}=${JSON.stringify(cgsVersion)}` + bundle.slice(use.index + assignment.length);
}

async function stageExtension(stage: string) {
  const workspace: Record<string, string> = {
    "@cgscli/connect": "packages/connect/src/index.ts",
    "@cgscli/wire": "packages/wire/src/index.ts",
  };
  const vendor: Record<string, string> = {};
  const vendorLicenses = new Set<string>();
  // Preserve the TS sources. Rewrite workspace imports to relative paths, and
  // vendor the extension's npm libraries so only omp externals are npm deps.
  for (const dir of ["plugin/omp-extension", "packages/connect/src", "packages/wire/src"]) {
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: path.join(root, dir) })) {
      if (file.endsWith(".test.ts") || file.split(path.sep).some((p) => p === "test" || p === "node_modules")) continue;
      const source = path.join(dir, file);
      let text = await readFile(path.join(root, source), "utf8");
      const imports = new Set([...Object.keys(workspace), ...ts.scan(text).imports.map(({ path: specifier }) => specifier)]);
      for (const specifier of imports) {
        const name = nameOf(specifier);
        let target = workspace[specifier];
        if (name === "yaml" || name.startsWith("@noble/")) {
          target = vendor[specifier];
          if (!target) {
            const out = `${Object.keys(vendor).length}.js`;
            target = vendor[specifier] = `vendor/${out}`;
            const entry = fileURLToPath(import.meta.resolve(specifier));
            const result = await Bun.build({
              entrypoints: [entry], target: "bun", outdir: path.join(stage, "vendor"), naming: out,
              format: "esm",
            });
            if (!result.success) throw new Error(`Failed to bundle ${specifier}: ${result.logs.join("\n")}`);
            if (!vendorLicenses.has(name)) {
              await copyFile(path.join(root, "node_modules", name, "LICENSE"), path.join(stage, "vendor", `${name.replace(/[@/]/g, "-")}.LICENSE`));
              vendorLicenses.add(name);
            }
          }
        }
        if (target) {
          const relative = path.relative(path.dirname(source), target).split(path.sep).join("/");
          text = text.replace(new RegExp(`(["'])${escapeRegex(specifier)}\\1`, "g"), JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`));
        }
      }
      const dest = path.join(stage, source);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, text);
    }
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "omp-dir": { type: "string" }, "out-dir": { type: "string" } },
  });
  const n = positionals[0] ?? process.env.CGS_RELEASE_N ?? "1";
  if (positionals.length > 1 || !/^[1-9]\d*(\.[1-9]\d*)?$/.test(n)) throw new Error("Expected one release number, N or N.M, e.g. 6 or 5.2 (or CGS_RELEASE_N)");
  const omp = path.resolve(values["omp-dir"] ?? "/tmp/omp-build");
  const out = path.resolve(values["out-dir"] ?? ".");
  const agent = path.join(omp, "packages/coding-agent");
  const manifest: Manifest = await Bun.file(path.join(agent, "package.json")).json();
  const ompRoot = await Bun.file(path.join(omp, "package.json")).json();
  const lock = Bun.JSONC.parse(await readFile(path.join(omp, "bun.lock"), "utf8")) as { packages: Record<string, LockEntry> };
  const version = `${manifest.version}-cgs.${n}`;
  const filename = `cicori-cgs-${version}.tgz`;
  const bundle = await readFile(path.join(agent, "dist/cli.js"), "utf8");
  const dependencies = bundleDependencies(bundle, manifest, ompRoot.workspaces.catalog, lock.packages);
  const cli = setBundleVersion(bundle, manifest.version, version);

  await mkdir(out, { recursive: true });
  const stage = await mkdtemp(path.join(os.tmpdir(), "cgs-release-"));
  const outputStage = await mkdtemp(path.join(out, ".cgs-release-"));
  try {
    const assets = new Set<string>();
    // The patched changelog has a dot after CHANGELOG, unlike the stock glob.
    for (const glob of [...manifest.files.filter((f) => f.startsWith("dist/")), "dist/CHANGELOG.*.md"]) {
      for (const file of new Bun.Glob(glob.endsWith("/types") ? `${glob}/**/*` : glob).scanSync({ cwd: agent })) assets.add(file);
    }
    for (const file of assets) {
      if (file === "dist/cli.js") continue;
      await mkdir(path.join(stage, path.dirname(file)), { recursive: true });
      await copyFile(path.join(agent, file), path.join(stage, file));
    }
    await mkdir(path.join(stage, "dist"), { recursive: true });
    await writeFile(path.join(stage, "dist/cli.js"), cli);
    await copyFile(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
    await copyFile(path.join(agent, "LICENSE"), path.join(stage, "dist/OMP-LICENSE"));
    await copyFile(path.join(agent, "THIRD-PARTY-NOTICES.txt"), path.join(stage, "dist/THIRD-PARTY-NOTICES.txt"));
    await stageExtension(stage);
    await mkdir(path.join(stage, path.dirname(template.bin.cgs)), { recursive: true });
    await copyFile(path.join(import.meta.dir, "release-launcher.ts"), path.join(stage, template.bin.cgs));
    await chmod(path.join(stage, template.bin.cgs), 0o755);
    await writeFile(path.join(stage, "package.json"), JSON.stringify({ ...template, version, engines: manifest.engines, dependencies }, null, 2) + "\n");

    const pack = Bun.spawn([process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--destination", outputStage], {
      cwd: stage, stdout: "inherit", stderr: "inherit",
    });
    if (await pack.exited !== 0) throw new Error("bun pm pack failed");
    await rename(path.join(outputStage, filename), path.join(out, filename));
    console.log(`${path.join(out, filename)} (${(await stat(path.join(out, filename))).size} bytes)`);
  } finally {
    await Promise.all([rm(stage, { recursive: true, force: true }), rm(outputStage, { recursive: true, force: true })]);
  }
}

if (import.meta.main) await main();
