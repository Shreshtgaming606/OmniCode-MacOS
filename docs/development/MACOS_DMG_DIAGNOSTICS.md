# OmniCode macOS DMG diagnostics

Last verified: 2026-09-27

## Current 0.9.0 release-preview rebuild

Both architecture-specific installers were rebuilt from the same dirty but
preserved `codex/work-mode` source tree after 632 automated tests passed, seven
tests remained intentionally gated, and TypeScript checking passed. No source
change was discarded or committed.

The migrated `.env.local` still points to an absolute publisher Google OAuth
credentials file that is absent on this Mac. Both packages therefore used the
explicit `--without-google-oauth` diagnostic path. They preserve the app's
secure missing-configuration behavior but are not feature-complete Gmail/Drive
production releases.

| Target | Validated app | DMG | SHA-256 | Validator |
| --- | --- | --- | --- | --- |
| arm64 | `dist/release-arm64/mac-arm64/OmniCode.app` | `dist/release-arm64/OmniCode-0.9.0-arm64.dmg` | `565f057b8f85080e3742240a211b1230a1de4f66467999b9e776082ecdaf588e` | 40 pass, 7 expected warnings, 0 fail |
| x86_64 | `dist/release-x64/mac/OmniCode.app` | `dist/release-x64/OmniCode-0.9.0-x64.dmg` | `f835a43938c2d1ce90b1a0ede4b32840a4f973cec494f013dac9d8ea009a7683` | 40 pass, 7 expected warnings, 0 fail |

The arm64 packaged runtime smoke passed Code, Work, Omni, real `node-pty`,
localhost boundaries, Managed Browser, native helper discovery, and zero
renderer errors. The packaged Ollama Settings card connected to Ollama 0.34.4,
showed the loopback endpoint, detected and selected `phi3:mini`, and completed
local/cloud/local model switching. A disposable synthetic-quarantine copy was
blocked with the ordinary “Apple could not verify” warning; the historical
“damaged and can't be opened” wording did not appear.

Rosetta remains unavailable, so the x86_64 artifact could not be runtime-smoked
on this Apple Silicon host. Its executable, Electron, active `node-pty`, and
both native helpers are x86_64; the unpacked and mounted apps pass strict deep
signature verification. A disposable quarantined x64 copy also remained
strict-signature-valid, but Launch Services returned `-10669` before showing a
Gatekeeper dialog because this host cannot execute x86_64 code. No “damaged”
wording appeared, but this is not a substitute for a Rosetta or Intel quarantine
test. Real Intel hardware remains the final runtime gate.

The current scripts write to separate `release-arm64` and `release-x64`
directories, validate the checksum files, and restore the active development
`node-pty` plus generated native helpers to the host architecture after an x64
cross-build. The proven final-write → helper-sign → outer-seal → verify →
prepackaged-DMG order is unchanged.

## Outcome

The Apple Silicon migration is healthy at the runtime and native-code level.
The previous packaging path was not healthy: when electron-builder found no
Developer ID identity, it skipped its final signing pass. The copied Electron
arm64 executable and nested Electron code still contained linker-generated
ad-hoc signatures, but electron-builder had changed the enclosing application
bundle. The resulting outer signature did not bind the final `Info.plist` or
resources.

The failure was reproduced before making packaging changes:

- `codesign --verify --deep --strict` failed with `code has no resources but
  signature indicates they must be present`;
- `syspolicy_check distribution` reported that error plus `The code signature
  does not fully cover the bundle's Info.plist`;
- `spctl` rejected the app as invalid rather than reporting only an untrusted
  distribution identity.

That is a real bundle-signature defect and can plausibly produce macOS's
“application is damaged” dialog. The original downloaded DMG is unavailable,
so this audit cannot prove that its bytes were identical to the reproduced
failure.

The corrected diagnostic build performs a complete ad-hoc sealing pass after
the application is assembled, restores the intended signatures and
entitlements on the two native Omni helpers, then reseals only the outer app.
The result is technically healthy and locally runnable, but remains unsuitable
for public distribution because it is not Developer ID signed or notarized.

## Build host

| Item | Verified value |
| --- | --- |
| Hardware | Mac mini, Apple M6, 12 cores, 16 GB RAM |
| Architecture | arm64 |
| macOS | 27.0 (26A425) |
| Xcode | 27.0 (27A266a) |
| Node | 24.21.0, arm64 process |
| npm | 11.19.0 |
| Electron | 44.1.0 |
| electron-builder | 26.15.3 |
| Application | OmniCode 0.9.0 |
| Developer ID identities | 0 |

## Configuration and build strategy

The normal `package.json` release configuration retains hardened runtime and
automatic Developer ID discovery for a future official release. It now enables
`forceCodeSigning`, so `npm run dist:arm64` fails instead of silently emitting
an incompletely sealed release when no identity is installed.

The explicit local diagnostic command is:

```sh
npm run dist:arm64:adhoc -- --without-google-oauth
```

It uses electron-builder 26 flat macOS signing options:

- `identity: "-"` for an explicit ad-hoc local signature;
- `hardenedRuntime: false` for that local build;
- `notarize: false` because no Developer ID/notary credentials exist;
- an arm64 Electron runtime and arm64 rebuild of `node-pty`;
- arm64 Swift builds of both Omni helpers.

The `--without-google-oauth` switch was necessary for this diagnostic artifact
because the migrated `.env.local` points to a developer credential JSON file
that does not exist on the new Mac. The resulting DMG has no publisher Google
OAuth client configuration and must not be treated as the feature-complete
OAuth release candidate.

The cursor helper is ad-hoc signed without extra entitlements. The speech helper
is ad-hoc signed with hardened runtime and
`com.apple.security.device.audio-input`. After restoring those narrow profiles,
the outer application is resealed. No file is modified after that final seal;
the DMG is produced from the already validated app with `--prepackaged`.

Version-specific references:

- [electron-builder 26 macOS signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)
- [electron-builder 26 macOS configuration](https://www.electron.build/v26/docs/mac/)
- [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

## Native architecture inventory

Every runtime-required Mach-O in the final app is arm64:

| Component | Type | Architecture | Status |
| --- | --- | --- | --- |
| `Contents/MacOS/OmniCode` | executable | arm64 | Pass |
| Electron Framework | dynamic library | arm64 | Pass |
| Electron crashpad/FFmpeg/SwiftShader | executable/libraries | arm64 | Pass |
| OmniCode Helper | executable | arm64 | Pass |
| OmniCode Helper GPU | executable | arm64 | Pass |
| OmniCode Helper Renderer | executable | arm64 | Pass |
| OmniCode Helper Plugin | executable | arm64 | Pass |
| Squirrel, ShipIt, Mantle, ReactiveObjC | framework code | arm64 | Pass |
| active `node-pty/build/Release/pty.node` | native Node bundle | arm64 | Pass |
| active `node-pty/build/Release/spawn-helper` | executable | arm64 | Pass |
| `omnicode-cursor-helper` | executable | arm64 | Pass |
| `omnicode-speech-helper` | executable | arm64 | Pass |

The unpacked dependency includes inactive `node-pty/prebuilds/darwin-x64`
files. They are not selected by the arm64 runtime; the active
`build/Release` module and helper are arm64. Windows prebuilds are also inert.

## Bundle validation

The final application contains:

- valid `Contents/Info.plist`;
- `CFBundleExecutable=OmniCode`;
- `CFBundleIdentifier=com.omnicode.editor`;
- `CFBundleName=OmniCode`;
- `CFBundlePackageType=APPL`;
- version 0.9.0 and minimum macOS 14.0;
- `Contents/MacOS/OmniCode`;
- Electron frameworks and helpers;
- `Contents/Resources/app.asar`;
- unpacked active `node-pty` files;
- executable Cursor and Speech helpers under `Resources/omni-native`.

`codesign --verify --deep --strict --verbose=4` passes on both the unpacked app
and the copy inside the DMG. The outer app has an ad-hoc signature, binds all 34
Info.plist entries, and seals 181 resource files. There is no Team ID.

## Final system-policy output

`syspolicy_check distribution` against the corrected unpacked app reports only
the expected trust/notarization limitations:

```text
Only one signature found in file:///.../OmniCode.app, skipping dual signature check
App has failed one or more pre-distribution checks.
---------------------------------------------------------------
Adhoc Signed App
    Severity: Warning
    Full Error: This app is adhoc signed. While it may run locally, adhoc
        signed apps are not suitable for distribution.
    Type: Distribution Error
    Suggested Fix: Sign the app with a valid Developer ID certificate for
        distribution.

Notary Ticket Missing
    File: OmniCode.app
    Severity: Fatal
    Full Error: A Notarization ticket is not stapled to this application.
    Type: Distribution Error
    Suggested Fix: Sign with Developer ID, submit with notarytool, and staple
        the accepted ticket.
---------------------------------------------------------------
```

There is no longer a Codesign Error, resource-envelope error, unbound
Info.plist, file-added-after-signing error, or invalid nested signature.

The relevant `spctl` results are:

```text
dist/release-arm64/mac-arm64/OmniCode.app: rejected

dist/release-arm64/OmniCode-0.9.0-arm64.dmg: rejected
source=no usable signature
```

These are distribution-trust failures, not evidence that the final app or DMG
is corrupt.

## Local runtime result

The corrected unpacked app launches through `open` on Apple Silicon. Packaged
smokes verified:

- Code Mode startup and workspace IPC;
- real zsh terminal output through arm64 `node-pty`;
- localhost serving and sensitive-path denial;
- Omni Mode, the Cursor helper, emergency stop, TTS, and Speech status;
- Work Mode persistence, Managed Browser, 13 Gmail tools, and 15 Drive tools;
- external-navigation denial and zero renderer errors.

The Cursor helper launches and safely reports `accessibility-denied` because
the new app identity has not been granted Accessibility permission. The Speech
helper launches successfully; unlike the old Intel host, this Mac reports the
`en-US` recognizer available and on-device recognition available. The current
release-preview smoke reported microphone granted and Speech permission still
not determined; no live transcript was captured during packaging validation.

## DMG result

| Field | Value |
| --- | --- |
| Path | `dist/release-arm64/OmniCode-0.9.0-arm64.dmg` |
| Size | 142,500,398 bytes |
| SHA-256 | `565f057b8f85080e3742240a211b1230a1de4f66467999b9e776082ecdaf588e` |
| `hdiutil verify` | Pass, checksum valid |
| Mount | Pass, read-only |
| App comparison | Pass, file-content equivalent to validated unpacked app |
| App signature inside DMG | Pass, deep/strict ad-hoc signature valid |
| Validator summary | 40 PASS, 7 expected warnings, 0 FAIL |

## Quarantine diagnostic

A disposable copy of the final app received a synthetic
`com.apple.quarantine` attribute. The release app and DMG were not modified.

- `codesign --deep --strict` still passed after quarantine;
- `spctl` rejected the copy;
- `open` returned to Launch Services, but no OmniCode process started;
- macOS displayed **“OmniCode Not Opened — Apple could not verify ‘OmniCode’
  is free of malware that may harm your Mac or compromise your privacy”** with
  Move to Trash and Done actions;
- the same unquarantined app had already launched and passed the packaged
  runtime smokes.

Result: **APPLICATION RUNTIME HEALTHY — GATEKEEPER DISTRIBUTION BLOCK**.

This synthetic test does not replace a real Safari/Chrome upload-download
cycle. The exact user-facing dialog must be recorded from the downloaded copy.
Do not remove quarantine, disable Gatekeeper, or use `sudo` as a release fix.
The observed verification/malware wording is distinct from the historical
“damaged and can't be opened” wording and confirms that the corrected artifact
now reaches the ordinary untrusted-developer/notarization policy boundary.

## Intel x86_64 cross-build

The repaired signing/resealing sequence was extended without changing the
arm64 pipeline. The Intel diagnostic package was cross-built on the same Apple
M6 Mac using Electron 44.1.0's x64 distribution, electron-builder's explicit
`--arch x64` dependency rebuild, and Swift's
`x86_64-apple-macos14.0` target.

The build command is:

```sh
npm run dist:x64:adhoc -- --without-google-oauth
```

`OMNICODE_TARGET_ARCH=x64` is the authoritative helper-build input. The build
does not depend solely on npm's deprecated `npm_config_arch` behavior. Before
packaging, the script verifies that active `node-pty` is x86_64. After the x64
artifact is complete, it rebuilds the active development `node-pty` module back
to the host Node architecture (arm64), leaving both architecture-specific
package outputs untouched.

Every runtime-required Mach-O in the Intel app is x86_64:

| Component | Architecture | Status |
| --- | --- | --- |
| OmniCode executable | x86_64 | Pass |
| Electron Framework, Crashpad, FFmpeg, and SwiftShader | x86_64 | Pass |
| Electron main/GPU/Renderer/Plugin helpers | x86_64 | Pass |
| Squirrel, ShipIt, Mantle, and ReactiveObjC | x86_64 | Pass |
| active `node-pty` module and `spawn-helper` | x86_64 | Pass |
| `omnicode-cursor-helper` | x86_64 | Pass |
| `omnicode-speech-helper` | x86_64 | Pass |

The packaged `node-pty/prebuilds/darwin-arm64` files are inactive fallbacks and
are not selected by the x64 runtime. The active `build/Release` module and its
helper, plus the matching `darwin-x64` prebuilds, are x86_64.

The Intel app uses the same repaired signing order as arm64. The Cursor helper
is narrowly ad-hoc signed, the Speech helper is ad-hoc signed with hardened
runtime and only `com.apple.security.device.audio-input`, and the completed
outer application is resealed last. Its final signature has no Team ID, binds
34 Info.plist entries, and seals 181 resources. Both the unpacked app and the
mounted DMG copy pass `codesign --verify --deep --strict`.

Intel artifact result:

| Field | Value |
| --- | --- |
| Host | Apple Silicon Mac mini (Apple M6) |
| Target | Intel x86_64, cross-built |
| Path | `dist/release-x64/OmniCode-0.9.0-x64.dmg` |
| Size | 149,255,123 bytes |
| SHA-256 | `f835a43938c2d1ce90b1a0ede4b32840a4f973cec494f013dac9d8ea009a7683` |
| `hdiutil verify` | Pass |
| Mounted app comparison | Pass, file-content equivalent |
| Validator | 40 PASS, 7 expected warnings, 0 FAIL |
| `syspolicy_check` | Ad-hoc signing warning and missing notary ticket only |
| App `spctl` | Rejected: no trusted notarized distribution identity |
| DMG `spctl` | Rejected: `source=no usable signature` |

There is no malformed resource envelope, unbound Info.plist, invalid nested
signature, or post-signing modification report.

Rosetta 2 is **not available** on this host. The package receipt and runtime
path are absent, and `/usr/bin/arch -x86_64 /usr/bin/uname -m` returns
`Bad CPU type in executable`. Rosetta was not installed. Consequently the x64
application, x64 `node-pty`, Managed Browser, and x64 native helpers could not
be runtime-smoked on this Mac. The artifact still requires runtime validation
on a real Intel Mac; Rosetta testing, if performed later, would not replace that
native-hardware gate.

Like the arm64 diagnostic build, this x64 artifact explicitly omits publisher
Google OAuth configuration because the migrated credentials-file path is
missing. It is not a feature-complete or publicly distributable release.

## Remaining public-release work

Normal external distribution still requires:

1. Apple Developer Program membership and a Developer ID Application identity.
2. Hardened Runtime with the minimum required app/helper entitlements.
3. Signing all nested code and the final app using the stable Developer ID
   identity and secure timestamps.
4. Apple notarization with `notarytool` and ticket stapling.
5. `codesign`, `syspolicy_check`, `spctl`, and quarantined download testing on
   the exact stapled artifact.
6. Restoration of the publisher Google OAuth credential input before producing
   the feature-complete release candidate.
7. Runtime smoke testing of the standalone x64 artifact on a real Intel Mac.

Xcode installation alone does not provide Developer ID credentials. The
current DMG is locally ad-hoc signed, not Developer ID signed, not notarized,
and not suitable for ordinary public download distribution.
