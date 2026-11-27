import { expect, test } from "bun:test";
import path from "node:path";
import { buildProfile, CONFIG_DIR_NAME, daemonDir } from "../../src/profile.ts";

const home = "/home/u";

test("the cgs daemon directory is under cgs's own config root, not omp's", () => {
  expect(daemonDir(home, {})).toBe(path.join(home, ".cgs", "run", "daemon"));
  expect(daemonDir(home, { PI_CONFIG_DIR: ".cgs-dev" })).toBe(path.join(home, ".cgs-dev", "run", "daemon"));
  expect(daemonDir(home, {})).not.toContain(".omp");
});

test("a child profile pins the daemon directory and inherits nothing of a stock omp daemon", () => {
  const p = buildProfile({
    agentDir: path.join(home, CONFIG_DIR_NAME, "agent"),
    ompBin: "/usr/bin/cgs",
    home,
    platform: "linux",
    baseEnv: { PATH: "/usr/bin", OMP_DAEMON_DIR: "/home/u/.omp/run/daemon", OMP_DAEMON_TCP: "127.0.0.1:9", CGS_DAEMON_DIR: "/elsewhere", HOME: home },
  });
  expect(p.env.CGS_DAEMON_DIR).toBe(path.join(home, ".cgs", "run", "daemon"));
  expect(p.env.OMP_DAEMON_DIR).toBeUndefined();
  expect(p.env.OMP_DAEMON_TCP).toBeUndefined();
});
