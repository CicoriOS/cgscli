# Connect wire v1

Import from `packages/connect/src/remote/wire/index.ts`. This is the same module on Bun and in a secure browser context. All fields below are public; helpers do not open sockets or access storage. Types are shown in TypeScript notation.

```ts
type PasswordVerifier = { v: 1; salt: string; secret: string };
type AuthorizedBrowser = { id: string; name: string; publicKeyJwk: JsonWebKey; addedAt: number };
type DeviceCredentials = { staticKey: { privateKey: string; publicKey: string }; verifier: PasswordVerifier | null; browsers: AuthorizedBrowser[] };
function createPasswordVerifier(password: string): Promise<PasswordVerifier>;
function createDeviceCredentials(verifier?: PasswordVerifier | null): DeviceCredentials;
function addBrowser(c: DeviceCredentials, b: AuthorizedBrowser): DeviceCredentials;
function revokeBrowser(c: DeviceCredentials, id: string): DeviceCredentials;
function fingerprint(pub: Uint8Array): {emoji:string[];short:string[];zh:string[];en:string[]};
const EMOJI_TABLE: readonly { readonly emoji:string; readonly zh:string; readonly en:string }[];
function toBase64(bytes: Uint8Array): string;
function fromBase64(encoded: string): Uint8Array;
interface Channel { seal(plain: Uint8Array): Uint8Array; open(cipher: Uint8Array): Uint8Array }

type WireMessage = { k:'hello'; proto:1 } | { k:'busy'|'taken_over'; by:string } | { k:'takeover' } | { k:'error'; code:string }
 | { k:'req'; id:string; method:string; path:string; body?:unknown } | { k:'res'; id:string; status:number; body:unknown }
 | { k:'open'; cid:string; path:string } | { k:'ready'; cid:string } | { k:'frame'; cid:string; text:string } | { k:'close'; cid:string; reason?:string };
function encodeMessage(message: WireMessage, options?: {compress?:boolean}): Promise<Uint8Array[]>;
class FrameDecoder { push(chunk: Uint8Array): Promise<WireMessage|null> }

type SavedBrowser = { pin:string; privateKey:CryptoKey; publicKeyJwk:JsonWebKey; name:string };
interface BrowserStore { load():Promise<SavedBrowser|null>; save(value:SavedBrowser):Promise<void> }
type Via = 'password'|'key';
type WireEvent = { type:'authenticated'; via:Via; browser:{id:string;name:string} }
 | { type:'registered'; browser:AuthorizedBrowser } // device: upsert using addBrowser
 | { type:'pinned'; pin:string } // browser: first connection; display full fingerprint
 | { type:'pin_mismatch'; expected:string; received:string } // do not replace the pin
 | { type:'auth_failed'; via:Via; code:string }
 | { type:'message'; message:WireMessage };
type Step = { outgoing:Uint8Array[]; events:WireEvent[] };
class DeviceSession {
 constructor(options:{credentials:DeviceCredentials;passwordAllowed?:()=>boolean;now?:()=>number});
 receive(payload:Uint8Array):Promise<Step>;
 send(message:WireMessage, options?:{compress?:boolean}):Promise<Uint8Array[]>;
}
class BrowserSession {
 constructor(options:{store:BrowserStore;name:string;password?:string});
 start():Promise<Step>;
 receive(payload:Uint8Array):Promise<Step>;
 send(message:WireMessage, options?:{compress?:boolean}):Promise<Uint8Array[]>;
}
```

Use a fresh session per relay `sid`. Serialize calls and deliver each `outgoing` in order as one `data.payload` (standard padded base64); never interleave chunks from concurrent `send`s. Relay `seq` is not an authentication mechanism. Run `start()` once on the browser; `receive` takes decoded bytes, not envelope JSON. No automatic `hello`: send it using `send` after authentication. Never pass handshake bytes to the host API. Process events **before** forwarding outgoing packets: persist `registered` into the *current* device credential record before the registration ACK; on persistence failure close without forwarding. Disconnect live sessions on revocation, credential reset or lock policy changes. No network operation on an invalid session should be retried; close on a rejected promise, `auth_failed` or `pin_mismatch` (flush any terminal outgoing response first). `auth_failed` codes: `wrong_password` is the device's password-key-confirmation failure (count it); `locked`, `password_unavailable`, `unknown_browser`, `bad_signature`, `password_required`, `authentication_failed` are not password guesses. Structural protocol/transport failures throw. Never auto-retry key failure with a password or silently re-pin.

All serialized keys, verifier bytes and pins use standard padded base64; `addedAt` is Unix milliseconds. Scope each browser store to the device and origin; store `CryptoKey` using structured clone (not JSON). `start()` chooses resume if a record exists regardless of password; otherwise it needs `password`. A `pin_mismatch.received` key is an **unauthenticated claim**, never an update. For a manual reset compare against the device terminal, explicitly clear the saved record and connect again with the password. Never persist passwords. The device verifier is password-equivalent and must be protected like the static private key. Call `createPasswordVerifier` in a worker on the daemon; its async interface is not CPU isolation. Set `verifier` to null and empty `browsers` on forget, or discard the record. Password change also invalidates every registered browser.

Message compression is per-message, not shared between records; pass `{compress:false}` for messages combining secrets with attacker-controlled text. `EMOJI_TABLE` byte indices are immutable protocol assignments. Compare **all 12** emojis (or spoken names) on first connect; the four-symbol form is for recognition only.
