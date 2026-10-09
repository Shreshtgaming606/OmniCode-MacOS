# OmniCode macOS support — v0.1.2

OmniCode has one source tree and two explicit release profiles. **Current**
requires macOS 15.0 or later; **Sonoma Legacy** targets macOS 14.0. Both are
built for Apple Silicon and Intel. The product version is 0.1.2; the
installer filename, minimum OS, and in-app Platform section identify the
release channel. User settings and Keychain services are shared, so upgrading
from Legacy to Current does not require a data migration.

| Feature | Current 15+ | Sonoma Legacy 14 |
| --- | --- | --- |
| Code, Work, Omni, Activity and Notification Center | Shared | Shared |
| Ollama, optional cloud AI, Gmail/Drive, Managed Browser | Shared | Shared |
| Speech helper, Cursor helper, ElevenLabs (when configured) | Shared | Shared |
| Apple Translation of explicitly submitted text/clipboard | On-device native tool and UI | Existing AI translation path only; never used when Local/System Translation was explicitly requested |
| Apple Vision `RecognizeTextRequest` for workspace images | On-device Code/Omni tool | Unavailable; no silent cloud OCR fallback |
| ScreenCaptureKit targeted OmniCode-window capture | Explicit UI action; Omni Cursor tool requires direct approval before recognized text reaches a model | Existing Cursor/Accessibility control only; targeted native capture hidden |
| HDR screenshot preset | Apple Silicon only | Unavailable |
| Core Spotlight metadata indexing | Workspace names, eligible Work titles, fixed actions | Same lexical metadata index |
| Semantic Spotlight query option | Requested via macOS 15+ API; related-word matching not yet verified | Unavailable; lexical search |
| App Intents actions in Shortcuts | 8 packaged definitions; Code, Work, and Omni mode actions ran in the final arm64 app on the macOS 27 test host after the Xcode extension repair | 7 packaged definitions; Translation omitted; runtime untested on macOS 14 |

The `src/main/services/platform-capabilities.ts` release and runtime capability
service is the single gate for modern features. The release profile is injected
at build time into trusted main code, not inferred solely from the host OS. A
Legacy app running on newer macOS remains Legacy. Native helper deployment
targets are selected from `scripts/macos-release-profile.mjs`; the Legacy
modern-helper binary is an inert macOS-14-compatible stub and imports no
macOS-15-only framework. The existing Code/Work/Omni service trees are not
forked.

## Build and validate

Run from the repository on macOS with Xcode and installed npm dependencies:

```sh
npm run dist:arm64
npm run dist:x64
npm run dist:legacy:arm64
npm run dist:legacy:x64
npm run release:mac
```

The first four commands build one variant each. `release:mac` runs typecheck,
tests, builds and validates all four, then writes a SHA-256 release manifest at
`dist/release-macos/OmniCode-0.1.2-release-manifest.json`. Individual installers
and `.sha256` files live in `dist/release-{current|legacy}-{arm64|x64}/`.
The high-level command does not publish a website, update a GitHub release,
or install the app.

The build preserves the repaired ad-hoc signing order: complete all resources,
re-sign native helpers with their narrow entitlements, reseal the outer app,
run strict/deep signature and architecture validation, create a DMG from the
validated prepackaged app, and validate its read-only mounted copy. The
validator checks the app and helper minimum versions, `node-pty`, signatures,
DMG integrity, and SHA-256. No app file is modified after final sealing.

**Ad-hoc signed is not Developer ID signed or notarized.** These builds are
public beta artifacts without Apple distribution trust. Gatekeeper may require
a user exception. A trusted macOS release still needs Developer
ID signing, notarization, stapling, and clean-TCC acceptance testing.

There is no automatic updater in this repository, so it cannot silently send
Current builds to Sonoma. Download links must present four manual choices;
recommend Current for macOS 15+ and Legacy for macOS 14, then let users choose
arm64 or x64. Browser user-agent detection is not reliable enough to hide
manual selection. The website presents all four validated 0.1.2 artifacts
with their profile and architecture requirements visible.

## Modern API and privacy notes

- `TranslationSession` and `LanguageAvailability` were introduced on macOS 15.
  macOS 15 uses SwiftUI `translationTask`; newer systems can use the direct
  installed-language initializer. Text never goes to an AI provider for the
  explicit on-device translation action. Missing language assets fail clearly.
- Swift Vision `RecognizeTextRequest` is macOS 15+. Only an image inside an
  authorized Code workspace can be read by its tool; processing stays local.
- ScreenCaptureKit's HDR screenshot preset is macOS 15+ and effective on Apple
  Silicon. The helper captures the exact OmniCode window identifier supplied
  by trusted main code, never a fallback whole-display frame. Its Omni tool
  requires direct approval before OCR text becomes model context. The manual
  capture UI uses a Save dialog.
- No Gmail body, Drive body, credentials, token, hidden model context, or
  terminal output is indexed or sent to a native system search service.

Runtime validation on this development Mac (macOS 27) does **not** prove
Sonoma behavior. Use the separate Sonoma checklist on real macOS 14 hardware.
See [macOS system integration](MACOS_SYSTEM_INTEGRATION.md) for indexing privacy,
deep links, Shortcuts action scope, and remaining validation gaps.
