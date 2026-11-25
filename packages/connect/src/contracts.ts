import type { Duplex } from "@cgscli/wire";

export type RouterStatus = { version: number; mode: "direct" | "relay"; endpoint?: string };
export interface Router {
  fetch(req: Request): Promise<Response>;
  status(): RouterStatus;
  subscribe(cb: (s: RouterStatus) => void): () => void;
  setTunnel(bundle: unknown): void;
  clearTunnel(): void;
}

export interface ModelEntry {
  id: string; name: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean;
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
export interface ModelManifest { providers: { id: string; channel: string; baseUrl: string; models: ModelEntry[] }[] }
export interface RotationEvent { provider: string; from: string; to: string; reason: string }
/** Virtual origin of cgsconnect's HTTP surface. Nothing listens on it: the extension hands requests to it by direct call (service.ts). */
export const CGSCONNECT_ORIGIN = "http://cgsconnect.invalid";

export interface ProviderHub {
  origin(): string;
  pushCredentials(slots: unknown): void;
  onRotation(cb: (ev: RotationEvent) => void): void;
  manifest(): ModelManifest;
}

export interface RemoteLink {
  start(): Promise<void>;
  stop(): Promise<void>;
  pairing(): Promise<{ code: string; expiresAt: number }>;
  devices(): Promise<{ id: string; name: string; online: boolean }[]>;
  accept(cb: (d: Duplex) => void): void;
}

export interface DoctorReport { ok: boolean; items: { name: string; status: "ok" | "missing" | "mismatch" | "unsupported"; detail?: string }[] }
export interface ComponentManager {
  doctor(): Promise<DoctorReport>;
  resolve(name: string): Promise<string | null>;
  envPath(): string[];
}

/** O3 is undecided: callers must choose; there is no default. */
export type TransportOption = { kind: "unix"; path: string } | { kind: "loopback"; port?: number };
