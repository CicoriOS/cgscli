// Connect wire v1: the same module runs on Bun (device side) and in the browser. See README.md.
export { toBase64, fromBase64 } from "./bytes.ts";
export { EMOJI_TABLE, fingerprint } from "./emoji.ts";
export { createPasswordVerifier, type PasswordVerifier } from "./pake.ts";
export type { Channel } from "./noise.ts";
export {
  addBrowser,
  changePassword,
  createDeviceCredentials,
  forgetCredentials,
  revokeBrowser,
  type AuthorizedBrowser,
  type DeviceCredentials,
} from "./credentials.ts";
export { encodeMessage, FrameDecoder, UNKNOWN_CHILD_REASON, WIRE_LIMITS, WireError, type EncodeOptions, type WireMessage } from "./messages.ts";
export {
  BrowserSession,
  DeviceSession,
  type BrowserSessionOptions,
  type BrowserStore,
  type DeviceSessionOptions,
  type SavedBrowser,
  type Step,
  type Via,
  type WireEvent,
} from "./session.ts";
