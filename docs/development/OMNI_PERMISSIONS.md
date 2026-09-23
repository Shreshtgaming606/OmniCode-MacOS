# Omni macOS Permissions

Last updated: 2026-09-23

## Boundary

`MacOSPermissionManager` is the single operating-system permission coordinator.
It is separate from the existing AI action `PermissionManager`: the former asks
macOS whether OmniCode may use a protected capability, while the latter decides
whether a proposed AI action requires user approval.

The manager exposes `detect → request → explain → open Settings → refresh →
verify`. Renderers receive only normalized state and invoke bounded IPC. They do
not call native APIs, read TCC, or grant themselves access.

Normalized states are `not-determined`, `requesting`, `granted`, `denied`,
`restricted`, `unavailable`, `requires-settings`, and `requires-restart`.
Authorization state is separate from feature availability; an authorized Speech
framework can still lack the selected locale's on-device recognition asset.

## Capability map

| Capability | Detection | Explicit request | Recovery after denial |
| --- | --- | --- | --- |
| Microphone | Electron `getMediaAccessStatus` plus native speech-helper status | Electron `askForMediaAccess('microphone')` and the fixed native capture boundary | Open Privacy & Security → Microphone; refresh when OmniCode becomes active |
| Speech Recognition | `SFSpeechRecognizer.authorizationStatus()` | Dedicated helper `request-permission` command calls `requestAuthorization` before recognizer/asset validation | Open Speech Recognition settings; refresh independently of asset availability |
| Accessibility | `isTrustedAccessibilityClient(false)` | `isTrustedAccessibilityClient(true)`, Electron's supported AX prompt path | Open Accessibility settings and recheck on return |
| Screen Recording | `getMediaAccessStatus('screen')` | A main-process `desktopCapturer.getSources` preflight invokes the real capture path | Open Screen Recording settings and recheck on return; a future failed capture after grant must surface restart-required rather than success |
| Notifications | `Notification.isSupported()` and a live verified `show` event in the current process | Show one explicit permission-test notification | Open Notifications settings; no persisted “granted” cache is trusted across launches |
| Automation | Per-target macOS Apple Events authorization | Requested only when an implemented Apple Events operation targets an app | Automation settings; never represented as a universal grant |
| Files & Folders | User-selected workspace/folder authority | macOS folder picker and existing workspace authorization | Re-select the folder; Omni does not request Full Disk Access |
| Launch at Login | Electron login-item settings | `setLoginItemSettings` | Login Items settings; this is a preference, not TCC permission |

## Process identity

The production bundle identifier remains `com.omnicode.editor`. The app carries
the hardened-runtime audio-input entitlement and the required Microphone/Speech
usage descriptions. Microphone,
Accessibility, screen capture, notification, and login-item requests originate
from the resident OmniCode application process wherever Electron exposes the
supported API. Apple Speech and audio capture remain in the fixed bundled Swift
speech executable. Because the current internal installers are ad-hoc signed,
stable Developer ID signing/notarization is still required before the helper's
TCC identity can be treated as a public-release identity.

The background/login architecture starts the main OmniCode application with
`--omni-background`; there is no independently signed post-quit helper. Cursor
and Speech resources are fixed executables, not model-selected programs.

## Request rules

- Requests occur only after an explicit Enable action or a user-invoked
  capability that clearly needs the permission.
- Multiple prompts are never fired in parallel.
- A denied permission routes to the exact System Settings pane when macOS will
  not show its native prompt again.
- Returning from System Settings triggers one refresh and broadcasts the new
  snapshot. There is no tight polling loop.
- Revocation cannot be faked. Except for Launch at Login, turning access off
  must route the user to System Settings.
- Accessibility is required by Cursor tools. Screen Recording is optional until
  a registered visual-observation tool actually uses screen pixels.
- No code manipulates TCC, invokes `sudo`, or asks users to weaken macOS.

## Development troubleshooting

Changing the bundle ID, app path, signing identity, or nested helper identity can
make macOS treat a build as a different application. Keep
`com.omnicode.editor`, the app location, and signing identity stable while
testing. Development permission resets, if needed, must be performed by the
developer outside OmniCode using Apple's normal development workflow; OmniCode
does not automate TCC resets.
