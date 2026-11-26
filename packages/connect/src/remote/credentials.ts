import { x25519 } from "@noble/curves/ed25519.js";
import { toBase64 } from "./bytes.ts";
import type { PasswordVerifier } from "./pake.ts";

export interface AuthorizedBrowser {
  id: string;
  name: string;
  publicKeyJwk: JsonWebKey;
  addedAt: number;
}
export interface DeviceCredentials {
  staticKey: { privateKey: string; publicKey: string };
  verifier: PasswordVerifier | null;
  browsers: AuthorizedBrowser[];
}

/** Create fresh device credentials. The private key is serialized only for persistence by the caller. */
export function createDeviceCredentials(verifier: PasswordVerifier | null = null): DeviceCredentials {
  const privateKey = x25519.utils.randomSecretKey();
  return { staticKey: { privateKey: toBase64(privateKey), publicKey: toBase64(x25519.getPublicKey(privateKey)) }, verifier, browsers: [] };
}

export function addBrowser(credentials: DeviceCredentials, browser: AuthorizedBrowser): DeviceCredentials {
  const browsers = credentials.browsers.filter((b) => b.id !== browser.id);
  browsers.push({ ...browser, publicKeyJwk: { ...browser.publicKeyJwk } });
  return { ...credentials, staticKey: { ...credentials.staticKey }, browsers };
}
export function revokeBrowser(credentials: DeviceCredentials, id: string): DeviceCredentials {
  return { ...credentials, staticKey: { ...credentials.staticKey }, browsers: credentials.browsers.filter((b) => b.id !== id) };
}
export function forgetCredentials(credentials: DeviceCredentials): DeviceCredentials {
  return { ...credentials, staticKey: { ...credentials.staticKey }, verifier: null, browsers: [] };
}
export function changePassword(credentials: DeviceCredentials, verifier: PasswordVerifier): DeviceCredentials {
  return { ...credentials, staticKey: { ...credentials.staticKey }, verifier, browsers: [] };
}
