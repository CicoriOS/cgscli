# cgscli

**cgscli is the omp we distribute** (a CGS build of omp with patches and pre-installed extensions, ADR 0012), not a separate program. This repo holds the extension, patches, build/sync scripts, and the optional `cgsconnect` library. Design documents: `../cgs-client-docs` (the source of truth; if code and docs disagree, fix the docs first).

| Path | What |
|---|---|
| `packages/wire` | Message contract (`Duplex`, hello/welcome, message families), TSP APC framing, replay buffer |
| `packages/connect` | cgsconnect: profile/isolation, pty + TSP host, sessions, protocol server, `router/` (API direct-first + relay tunnel), `providers/` (channels, manifest, session identity epoch, local proxy), `remote/` (E2E relay link), `components/` (components.lock, downloader, doctor) |
| `plugin/omp-extension` | Pre-installed omp extension: CGS login provider (`/login`), subscription channels from cgsconnect's manifest, `/cgs-doctor` and `/cgs-update` |
| `patches/` | Patch series for omp (MIT, see `patches/LICENSE`): `0001` P4 branding (CGS logo and wordmark, `CHANGELOG.cgs.md`, update gate); `0002` P5 builds `crates/shell` on Linux (`rusage_info_v4` is macOS-only); `0003` P6 lists the `cgs` login first; `0004` P7 yuan prices for `cgs-*` models, no omp-side cost for them (the relay bills), the `cny` usage unit, and "Cicori Good Service" as the provider name; `0005` P8 `cgs-*` channels take their vendor's request style (ADR 0021); `0006` P9 channels switch their session identity at run time (ADR 0022); `0007` P10 lets the extension guide unknown-tool errors using the request's wire declarations (ADR 0023) |
| `scripts/` | `fetch-omp`, `replay-patches` (`git am --3way`), `patch-limits`, `update-check`, `lock-component` |
| `omp.lock.json`, `components.lock` | Pinned omp commit; pinned third-party components (hashes are produced by `lock-component`, never typed) |

```
bun install
bun test                      # all packages, the extension and scripts
```

In the installed omp: `/login` -> CGS signs in with the device flow; `/cgs-doctor` and `/cgs-update` check and install components.

## Decisions deliberately left open

These are owner decisions in the docs; the code takes them as required inputs instead of choosing.

| ID | Where it shows up |
|---|---|
| O3 local transport | Decided (ADR 0017): unix socket / named pipe, one JSON message per line, default endpoint from `defaultEndpoint()`. The provider proxy binds loopback only because omp reaches providers over HTTP. |
| O4 patch count/file limits | `patches/limits.json` holds `null`; `scripts/patch-limits.ts` reports them as undecided and does not enforce. |
| Noise pattern for remote (XX vs IK) | `createRemoteLink({ pattern })` is required. |
| Pairing approval UX | `createRemoteLink({ approve })` is optional; without it a valid single-use pairing code authorizes. |

## Not implemented, and why

- **TSP body format** (hello reply, op frames, ack, event shapes): the files that define it (`packages/tui/src/native/*`) are not in the omp commit the docs were read at (`76b7d84`), and the TS SDK was not read. `TspCodec` is an injected interface of the optional cgsconnect; only APC framing and the `send` event (`{ev:"send",sf,id,text}`) are encoded here. [V6]
- **The omp build itself** (ADR 0012): P4-P9 replay cleanly on `76b7d84` and the patched tree builds in the `cgscli-build` image (`docker/build.sh`, which installs the binary as `dist/cgs`) and starts. Branding is not finished: the version string, `APP_NAME`, config dir and setup wizard text still say omp; no update source exists. cgsconnect is loaded in-process by the extension (ADR 0014); the API origin is chosen by Bootstrap among the build-time candidates in `plugin/omp-extension/defaults.ts` (ADR 0015; `CGS_BASE_URL` replaces the list). Account switching is a session identity change (ADR 0022): the hub keeps a per-channel epoch and omp (P9) asks it for the wire session id; there are no per-channel slot credentials.
- **Windows ConPTY** pty backend ([V1]): `bunPty` throws on win32; the `PtyFactory` seam is where it goes.
- **Server side** of the relay and device registration (`/api/devices`, `/api/relay/*`) does not exist in new-api yet; `remote/` is tested against a mock relay following `relay-protocol.md` (a proposal). `ctl` bodies are this implementation's assumption (see `remote/envelope.ts`).
- **Components**: `components.lock` ships empty. Entries (Chromium, LLVM, cmake/ninja, PortableGit) need real versions and URLs; add them with `scripts/lock-component.ts`.

## License

AGPL-3.0-only (`LICENSE`); `patches/` is MIT. See `NOTICE`.
