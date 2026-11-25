export interface Pty {
  write(data: string | Uint8Array): void;
  onData(cb: (d: Uint8Array) => void): void;
  onExit(cb: (code: number | null) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions { cmd: string[]; cwd?: string; env: Record<string, string>; cols?: number; rows?: number }
/** Seam for platforms: Linux uses Bun's built-in terminal; Windows ConPTY is [待验证 V1] and needs its own factory. */
export type PtyFactory = (o: PtySpawnOptions) => Pty;

export const bunPty: PtyFactory = (o) => {
  if (process.platform === "win32") throw new Error("ConPTY backend not available (V1 unverified)");
  const data: ((d: Uint8Array) => void)[] = [];
  const exit: ((c: number | null) => void)[] = [];
  const proc = Bun.spawn(o.cmd, {
    cwd: o.cwd,
    env: o.env,
    terminal: { cols: o.cols ?? 100, rows: o.rows ?? 30, data: (_t, d) => data.forEach((f) => f(d)) },
  });
  void proc.exited.then((c) => exit.forEach((f) => f(c)));
  return {
    write: (d) => proc.terminal!.write(d),
    onData: (cb) => void data.push(cb),
    onExit: (cb) => void exit.push(cb),
    resize: (c, r) => proc.terminal!.resize(c, r),
    kill: () => proc.kill(),
  };
};
