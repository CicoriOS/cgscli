import { generateStatic } from "./noise.ts";
import type { PasswordVerifier } from "./pake.ts";
import { toBase64 } from "./bytes.ts";

/** A browser the device has authorized: its non-extractable ECDSA P-256 public key and the name it gave itself. */
export type AuthorizedBrowser = { id: string; name: string; publicKeyJwk: JsonWebKey; addedAt: number };

/**
 * Everything a device persists for remote access. The static private key and the verifier are secrets (the verifier
 * is password-equivalent): store the record with owner-only permissions.
 */
export type DeviceCredentials = {
  staticKey: { privateKey: string; publicKey: string };
  verifier: PasswordVerifier | null;
  browsers: AuthorizedBrowser[];
};

export function createDeviceCredentials(verifier: PasswordVerifier | null = null): DeviceCredentials {
  const keys = generateStatic();
  return { staticKey: { privateKey: toBase64(keys.privateKey), publicKey: toBase64(keys.publicKey) }, verifier, browsers: [] };
}

const clone = (c: DeviceCredentials, browsers: AuthorizedBrowser[], verifier = c.verifier): DeviceCredentials => ({
  staticKey: { ...c.staticKey },
  verifier: verifier && { ...verifier },
  browsers,
});

/** Adds or replaces (by id) an authorized browser. */
export function addBrowser(c: DeviceCredentials, browser: AuthorizedBrowser): DeviceCredentials {
  const browsers = c.browsers.filter((b) => b.id !== browser.id);
  browsers.push({ ...browser, publicKeyJwk: { ...browser.publicKeyJwk } });
  return clone(c, browsers);
}

export function revokeBrowser(c: DeviceCredentials, id: string): DeviceCredentials {
  return clone(c, c.browsers.filter((b) => b.id !== id));
}

/** `/connect forget`: no password, no authorized browsers. The device key is kept so its fingerprint stays the same. */
export function forgetCredentials(c: DeviceCredentials): DeviceCredentials {
  return clone(c, [], null);
}

/** A new password invalidates every authorized browser (ADR 0036 section 5). */
export function changePassword(c: DeviceCredentials, verifier: PasswordVerifier): DeviceCredentials {
  return clone(c, [], verifier);
}
