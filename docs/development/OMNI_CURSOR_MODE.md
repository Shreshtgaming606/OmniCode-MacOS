# Omni Cursor Mode Architecture

Last updated: 2026-09-21

Status: **Structured native pointer/keyboard foundation implemented and
automated-verified; read-only native observation and the process-level
emergency-stop chord are live-verified; semantic screen observation and live
general input tests remain**

## Current repository reality

OmniCode now has a narrow native Cursor Mode path rather than a renderer or
shell automation shortcut:

- `src/shared/omni-cursor-contracts.ts` defines the closed request/result
  types and all size, coordinate, timing, text, and key limits.
- `src/main/services/omni-cursor-service.ts` validates requests and responses,
  launches one fixed helper executable without a shell, enforces timeouts and
  cancellation, owns task sessions, and detects pointer takeover between
  actions and during smooth movement.
- `src/main/services/omni-computer-tool-service.ts` registers only structured
  `computer.*` tools and binds every session to an active Omni task.
- `native/omni-cursor-helper/main.swift` uses AppKit/ApplicationServices to
  observe the pointer/frontmost application, move, click, double-click, scroll,
  type bounded Unicode, press allowlisted keys, and focus a fixed application
  allowlist.
- `scripts/build-omni-cursor-helper.mjs` builds the helper for the requested
  package architecture. `package.json` packages it beneath
  `Resources/omni-native/omnicode-cursor-helper`.
- The main-process Omni API reports helper and Accessibility readiness. The UI
  disables Cursor Mode when either is unavailable instead of offering a fake
  successful state.

The helper has a strict versioned JSON protocol. It accepts no AppleScript,
shell text, JavaScript, selectors, executable paths, arbitrary bundle IDs, or
model-supplied permission/risk data. `agent-command-policy.ts` continues to
block `osascript`, `automator`, `screencapture`, and `tccutil`.

## Mode and approval boundary

Execution mode and approval mode remain independent:

| Execution | Approval | Meaning |
| --- | --- | --- |
| Invisible | Ask/Auto/Full | Use structured background/API tools without pointer control |
| Cursor | Ask/Auto/Full | Permit registered `computer.*` tools through normal policy |

Changing to Cursor Mode grants no action by itself. `OmniToolRouter` exposes
computer tools only for a Cursor task. Every action still passes schema/size
validation and `PermissionManager` in the main process. Click, double-click,
typed text, and key presses use non-bypassable direct confirmation even when
the task's approval setting is Full Access. Secret-looking typed text is
rejected after approval as a second boundary.

Invisible Mode never posts native pointer or keyboard events. If a task needs
Cursor Mode, the user must explicitly switch modes and the controller
invalidates stale calls from the prior execution generation.

## Trusted pipeline

```text
OmniController
  -> mode-aware OmniToolRouter
  -> structured computer.* ToolDescriptor
  -> ToolRegistry schema/size/timeout validation
  -> PermissionManager
  -> OmniComputerToolService task session
  -> OmniCursorService validation/cancellation/takeover checks
  -> fixed Swift helper protocol
  -> bounded observation/result
  -> secret-sanitized model result + redacted Activity
```

The model and renderers never receive a native handle, general event-posting
capability, helper path, subprocess primitive, or raw protocol channel. The
restricted overlay has no Cursor API.

## Implemented command surface

| Tool | Native command | Boundary |
| --- | --- | --- |
| `computer.observe` | `observe` | Pointer and bounded frontmost-app metadata only |
| `computer.move` | `move` | Active-display coordinates, max 1 second |
| `computer.click` | `click` | Left/right, one click, always confirm |
| `computer.double-click` | `click` | Left/right, exactly two clicks, always confirm |
| `computer.scroll` | `scroll` | Bounded x/y pixel deltas |
| `computer.type-text` | `type-text` | 8,192 chars, secret scan, always confirm |
| `computer.press-key` | `press-key` | Named/ASCII allowlist, bounded modifiers/repeats, always confirm |
| `computer.focus-app` | `focus-application` | Fixed application-ID allowlist; app must already run |

Not implemented: AX element discovery/actions, screenshots, OCR,
ScreenCaptureKit, arbitrary application identifiers, arbitrary URLs,
application launch, password-field inspection, or a generic wait/script
command. These are intentionally not simulated by the current foundation.

## Helper process and validation

Each native request starts the fixed helper with `shell: false`, writes one
bounded JSON line to stdin, verifies the version and random request ID in the
response, bounds stdout/stderr, and terminates on abort or timeout. Unknown
fields and operations fail closed in Swift. The helper rechecks
`AXIsProcessTrusted()`, validates coordinates against active displays, marks
synthetic CGEvents, and returns only a bounded post-action observation.

Development builds resolve the helper from `out/native`; packaged builds
resolve it from the application Resources directory. Both `x86_64` and `arm64`
Swift targets compile on the current host. Runtime verification on actual Apple
Silicon hardware is still required.

## Human takeover and stopping

Task-owned sessions retain the last expected pointer location. The service
polls between actions; movement outside the tolerance triggers a
`pointer-moved` takeover, stops the session, and calls
`OmniController.pauseForUserTakeover`. Smooth native moves also detect pointer
displacement during the move and return a `user-takeover` failure. Resume is an
explicit controller operation and restores only that task's session.

Normal Pause, Stop, plan changes, skips, and mode changes invalidate the
controller generation and abort pending tool work. Task cleanup stops the
cursor session. While Omni is enabled, the Electron main process—not either
renderer—owns a fixed `⌘⇧Esc` global shortcut. Cursor readiness requires that
registration to succeed. The shortcut stops every active Cursor task, aborts
the provider/native action, cleans its session, and opens the restricted overlay
with the stopped result. The packaged audit started a real Google-backed Cursor
task, posted the actual chord through the bundled helper, and observed the task
reach `stopped` with “Stopped by the user.”

A lower-level helper-owned event tap would add protection if Electron's main
process itself hangs. That defense-in-depth path is not yet implemented and
remains a release-hardening item, but the current stop no longer depends on a
working renderer.

## Privacy and sensitive operations

The current `observe` result contains pointer coordinates plus bounded
frontmost application name, bundle ID, and PID. It does not capture a screen,
AX tree, field value, page, document, or clipboard. Activity and model-facing
tool results pass through the existing redaction/sanitization boundary.

Because semantic secure-field detection does not exist yet, current typing is
limited by direct approval and a secret-pattern block. Cursor Mode must not be
used for passwords, passcodes, API keys, payment data, recovery phrases,
authorization codes, Keychain, system authorization, or OmniCode approval UI.
Native semantic field targeting and secure-field blocking are required before
those UI categories can be considered safely observable.

## Permissions and packaging

- Accessibility is required and checked before Cursor Mode can start.
- Screen Recording is not requested because this implementation captures no
  pixels.
- Input Monitoring is not requested by the polling/globalShortcut foundation.
  A future helper-owned event tap may require it.
- Automation/Apple Events is not used.
- The production package must sign the helper and main app consistently,
  notarize/staple the result, and verify stable TCC attribution.

Permission denial is reported as an exact unavailable state. It never falls
back to AppleScript, shell automation, or fake completion.

## Verification completed

Automated tests cover helper path resolution, protocol/version/request-ID
validation, stdout/time/request limits, abort/timeout/process failure, request
validation, application/key allowlists, Accessibility states, session
lifecycle, movement takeover, polling takeover, resume/cleanup, tool
registration, cursor-only routing, always-confirm descriptors, secret-text
rejection, and controller pause-on-takeover.

Both native architecture targets compile. A live read-only helper invocation
on the current macOS host returned a valid pointer/frontmost-application
observation with Accessibility granted. The full TypeScript build recognizes
the helper and the renderer reports structured Cursor readiness.

## Remaining release gates

- Live safe-app move/click/scroll/type/key/focus testing with visible approval.
- Helper-owned emergency event tap and low-level event-queue cancellation as
  defense in depth; the main-process global `⌘⇧Esc` path is implemented.
- Semantic AX observation/targeting and secure/system-dialog blocking.
- Signed/notarized packaged helper with stable Accessibility permission.
- Permission grant, denial, revocation, restart, lock, and crash tests.
- Multiple displays/Spaces, Reduce Motion, and real Apple Silicon runtime tests.
- No-secret scans over packaged Cursor Activity, diagnostics, and model context.

Until those gates pass, documentation may claim a structured Cursor Mode
foundation and real read-only observation, but not fully autonomous arbitrary
macOS control or release readiness.
