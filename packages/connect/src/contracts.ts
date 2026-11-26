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
  id: string; name: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: ("text" | "image")[];
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
export interface ModelManifest { providers: { id: string; channel: string; baseUrl: string; models: ModelEntry[] }[] }
/** NewAPI moved on (`refresh`, `switched` or `rotate`): the channel's requests now carry a new wire session id. */
export interface IdentityEvent { provider: string; epoch: number; reason: string }
/** NewAPI reported a different channel than before (`from` -> `to` are channel ids). Observed, never requested. */
export interface ChannelEvent { provider: string; kind: "switched" | "refreshed"; from?: number; to: number }
/** Virtual origin of cgsconnect's HTTP surface. Nothing listens on it: the extension hands requests to it by direct call (service.ts). */
export const CGSCONNECT_ORIGIN = "http://cgsconnect.invalid";

export interface ProviderHub {
  origin(): string;
  /** The session id to put on the wire for `provider` under its current identity (omp patch P9; ADR 0022). */
  sessionIdentity(provider: string, sessionId: string): string;
  onIdentity(cb: (ev: IdentityEvent) => void): void;
  onChannel(cb: (ev: ChannelEvent) => void): void;
  /** Channel NewAPI last reported for a provider; read-only. */
  lastChannel(provider: string): number | undefined;
  manifest(): ModelManifest;
}

export interface RemoteLink {
  start(): Promise<void>;
  stop(): Promise<void>;
  pairing(): Promise<{ code: string; expiresAt: number }>;
  devices(): Promise<{ id: string; name: string; online: boolean }[]>;
  accept(cb: (d: Duplex) => void): void;
}


