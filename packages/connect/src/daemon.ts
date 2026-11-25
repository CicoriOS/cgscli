import { bunPty, type PtyFactory } from "./pty.ts";
import { Server } from "./server.ts";
import { listen, type Listener } from "./transport.ts";
import type { RemoteLink } from "./contracts.ts";
import { buildProfile, type ProfileOptions } from "./profile.ts";
import type { TransportOption } from "./contracts.ts";
import type { TspCodec } from "./tsp-host.ts";

export interface DaemonOptions {
  /** O3 is undecided: required, no default. */
  transport: TransportOption;
  connectVersion: string;
  ompVersion?: string | null;
  profile: ProfileOptions;
  codec: TspCodec;
  /** Override for tests (fake omp) or non-Linux platforms. */
  spawn?: PtyFactory;
  /** Command line prefix; default is [profile.ompBin, ...profile.args]. */
  cmd?: string[];
  /** Remote access link; the caller starts and stops it. Remote clients speak the same protocol. */
  remote?: RemoteLink;
}

export interface Daemon { address: string; server: Server; stop(): void }

export function startDaemon(o: DaemonOptions): Daemon {
  const profile = buildProfile(o.profile);
  const server = new Server({
    connectVersion: o.connectVersion,
    ompVersion: o.ompVersion ?? null,
    remote: o.remote,
    newSession: (id, req) => ({
      id,
      spawn: o.spawn ?? bunPty,
      cmd: o.cmd ?? [o.profile.ompBin, ...profile.args],
      cwd: req.cwd,
      env: profile.env,
      codec: o.codec,
    }),
  });
  const l: Listener = listen(o.transport, (ch) => server.serve(ch));
  o.remote?.accept((ch) => server.serve(ch));
  return { address: l.address, server, stop: () => { server.close(); l.stop(); } };
}
