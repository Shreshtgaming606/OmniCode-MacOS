# OmniCode Beta v1 0.1.0 — platform-profile candidate

## Current OmniCode · macOS 15+

Current keeps the shared Code, Work, and Omni experience and adds three local
system integrations: explicit Apple Translation of clipboard/text, Apple
Vision text recognition for workspace images, and exact-window ScreenCaptureKit
snapshots (with an Apple-Silicon-only HDR preset). The native translation
action does not send text to an AI provider. An Omni window-read tool requires
direct approval before recognized window text can enter model context.
Current also packages a metadata-only Core Spotlight index and eight native
App Shortcuts. Its query path requests macOS 15 semantic matching, though
related-word matching is not yet validated. Ask Omni currently opens the Omni
interface rather than returning a Shortcuts answer; Translate Clipboard opens
the existing on-device UI but does not return Shortcuts output.

App Shortcuts are currently a **candidate integration, not a verified working
feature**: an initial registered-app test showed all eight actions, but an
action run on the development macOS 27 Mac failed when the helper extension
crashed during startup. A later freshly packaged Current arm64 test app
registered with PlugInKit but its actions did not appear in the restarted
Shortcuts catalog. See `docs/platform/MACOS_SYSTEM_INTEGRATION.md` before release.

## OmniCode Sonoma Legacy · macOS 14+

Sonoma Legacy keeps the shared editor, agents, terminal, local AI, connectors,
speech, cursor control, and Notification Center. macOS-15-only native actions
are hidden; an inert 14.0-targeted adapter prevents new framework imports on
Sonoma. Existing AI translation remains a separate, clearly non-native path.
Legacy receives compatible security and core fixes but not every future native
integration. **Runtime testing on a real Sonoma Mac is still required.**
Legacy packages the same lexical Spotlight metadata index and seven native
App Shortcuts, omitting Translate Clipboard. See
`docs/platform/MACOS_SYSTEM_INTEGRATION.md` for exact behavior and privacy.

Both channels use the same version 0.1.0 and user-data format, with distinct
installer names and minimum macOS metadata. The four-installer release manifest
is generated only after all four builds pass validation.

These are ad-hoc signed, unnotarized testing artifacts. Developer ID signing,
notarization, stapling, and a clean install/TCC matrix are still required for
a trusted public release. Neither a structural DMG check nor a local Apple
Silicon smoke test is equivalent to a Sonoma or Intel runtime test.
