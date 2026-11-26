// Entry the omp daemon's `cgsconnect` module imports (patch P12): `open(stateDir, key, params)` returns the unit omp
// manages. The unit's persistent state lives in `params.stateFile` (next to the account in the agent dir, so the omp
// process can read the switch without waking the daemon), else under the module's own state dir.
import path from "node:path";
import { defaultDeps, RemoteUnit, type Configure } from "./unit.ts";

type Exit = { exitCode?: number; reason?: string };

export interface RemoteDaemonUnit {
  label: string;
  ready: Promise<void>;
  exited: Promise<Exit>;
  pids(): number[];
  busy(): boolean;
  attach(tunnel: { close(): void }): void;
  stop(reason: string): Promise<void>;
  invoke(method: string, params: unknown): Promise<unknown>;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function text(params: unknown, name: string): string {
  const v = record(params)[name];
  if (typeof v !== "string" || v === "") throw new Error(`${name}_required`);
  return v;
}

function configureFrom(params: unknown): Configure {
  const p = record(params);
  const command = Array.isArray(p.command) && p.command.every((c) => typeof c === "string") ? (p.command as string[]) : null;
  if (!command || command.length === 0) throw new Error("command_required");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(p.env))) if (typeof v === "string") env[k] = v;
  return {
    baseUrl: text(p, "baseUrl"),
    clientSecret: text(p, "clientSecret"),
    deviceName: text(p, "deviceName"),
    agentDir: text(p, "agentDir"),
    command,
    env,
    ...(typeof p.proxy === "string" && p.proxy ? { proxy: p.proxy } : {}),
  };
}

export async function open(stateDir: string, key: string, params: unknown): Promise<RemoteDaemonUnit> {
  const given = record(params).stateFile;
  const file = typeof given === "string" && path.isAbsolute(given) ? given : path.join(stateDir, `${key}.json`);
  const unit = new RemoteUnit(defaultDeps(file));
  await unit.init();
  const exited = Promise.withResolvers<Exit>();
  return {
    label: "CGS remote access",
    ready: Promise.resolve(),
    exited: exited.promise,
    pids: () => [],
    busy: () => unit.busy(),
    attach: (tunnel) => tunnel.close(),
    async stop(reason) {
      await unit.stop();
      exited.resolve({ reason });
    },
    async invoke(method, args) {
      switch (method) {
        case "configure":
          return unit.configure(configureFrom(args));
        case "status":
          return unit.status();
        case "entitlement":
          return unit.entitlement();
        case "enable":
          return unit.enable();
        case "disable":
          return unit.disable();
        case "setPassword":
          return unit.setPassword(text(args, "password"));
        case "forget":
          return unit.forget();
        case "revokeBrowser":
          return unit.revokeBrowser(text(args, "id"));
        case "unlock":
          return unit.unlock();
        default:
          throw new Error(`unknown cgsconnect method ${method}`);
      }
    },
  };
}
