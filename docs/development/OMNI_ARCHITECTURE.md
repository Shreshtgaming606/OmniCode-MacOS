# Omni Mode Architecture

Last updated: 2026-09-21

Status: **Text/overlay/TTS and structured native Cursor foundations are
implemented and automated-verified; speech input, local wake, semantic screen
observation, an emergency-stop chord, and a post-quit helper remain**

## Purpose

Omni is the third and final primary OmniCode mode. It is a voice-first general
macOS assistant that must coordinate existing Code and Work capabilities through
the same trusted backend. It is not a fourth product, a second provider stack,
or a renderer-side automation layer.

The final mode selector is:

- **Code** — build software with AI.
- **Work** — work with connected applications and information using AI.
- **Omni** — talk to the Mac and let AI coordinate the task.

This document separates implemented behavior from the remaining Omni target. A
target described here is not considered implemented or verified until its test
gate passes and the permanent status/test documents record that evidence.

## Audited current implementation

Omni is now a real third application mode in the working tree:

- `AppMode` validates `code | work | omni` in
  `src/shared/work-contracts.ts`.
- `src/renderer/src/components/modes/ModeSwitcher.tsx` renders the three-entry
  keyboard-accessible selector, and `src/renderer/src/App.tsx` keeps all three
  hosts mounted so changing modes does not discard Code or Work state.
- `src/shared/omni-contracts.ts` owns bounded settings, task, public-plan,
  activity, control, voice, and permission contracts.
- `src/main/services/omni-controller.ts` owns the task lifecycle and reuses the
  existing provider-neutral `WorkAgentManager` loop rather than creating a
  second provider stack.
- `OmniSettingsManager` and `OmniTaskStore` provide validated, atomic, private
  global settings and bounded redacted task history. Raw task input and raw tool
  results are runtime-only and are not written to that history.
- `OmniToolRouter` composes the existing Code and Work registries under one
  injected `PermissionManager`, preserves the source registry for collisions,
  and fails closed when an operation is unavailable in the selected execution
  mode.
- Gmail and Drive schemas are offered only when the connector is connected and
  its required scopes exist. The Omni Managed Browser uses a dedicated
  `persist:omnicode-omni-browser-v1` session rather than sharing Code or Work
  browser state.
- `src/renderer/src/components/omni/OmniMode.tsx` presents model/settings,
  typed-request fallback, public plans, redacted Activity, history, permissions,
  Pause/Resume/Stop, Modify Plan, Skip Step, and execution-mode controls. Full
  Access requires an explicit warning acknowledgement that is also enforced in
  the main process.
- A separate sandboxed overlay is built from `src/renderer/omni-overlay.html`
  and `src/preload/omni-overlay.ts`. Its allowlisted IPC surface can start and
  control Omni tasks but cannot invoke filesystem, terminal, Git, connector,
  credential, browser, or application APIs directly.
- The resident Electron process owns a configurable global shortcut (default
  `⌘⇧Space`), optional menu-bar item, and optional main-app login item. A
  packaged login/background launch initializes Omni without creating the main
  window and hides the Dock icon. The overlay is created lazily, stays above
  ordinary windows, and can appear on full-screen Spaces.
- `MacOSSayTextToSpeechProvider` provides real bounded macOS speech output via
  the fixed `/usr/bin/say` executable with no shell, installed-voice discovery,
  cancellation, concurrency control, validated rate/voice input, and
  secret-like text redaction.

The trusted backend remains an Electron 44 main process. Main and overlay
renderers are sandboxed, context-isolated, have Node integration disabled, and
receive distinct typed preload APIs. Every main-process IPC handler validates
the exact window, main frame, local URL, and bounded payload appropriate to the
surface.

Current non-capabilities are equally important:

- no microphone capture or speech-to-text provider;
- no local “Hey Omni” detector or wake helper;
- no signed lightweight helper that can activate Omni after explicit app quit;
- no native screen/AX-element observation or semantic element targeting;
- no always-available native emergency-stop chord/event tap;
- no signed/notarized production identity for the bundled Cursor helper.

A structured Swift CGEvent helper now provides bounded pointer/keyboard actions,
allowlisted application focus, read-only pointer/frontmost-app observation, and
polling/smooth-move user-takeover detection. The command policy continues to
block AppleScript, `screencapture`, `tccutil`, and similar shell bypasses. This
foundation is not represented as full semantic or release-ready arbitrary-app
control.

## Implemented flow and remaining target

Every Omni action follows this path:

```text
typed request (implemented) or SpeechToTextProvider (not yet implemented)
  -> main-process OmniController
  -> shared AIManager / selected model
  -> concise public plan or structured tool request
  -> unified mode-aware ToolRegistry
  -> PermissionManager
  -> fixed executor (Code, Work, isolated Omni Browser, or structured native
     Cursor helper when Cursor Mode is explicitly ready)
  -> bounded/redacted result
  -> OmniController
  -> model response
  -> sanitized full UI / overlay state
  -> real macOS TextToSpeechProvider when spoken responses are enabled
```

The model can propose only an application-owned tool ID and structured input.
It cannot register a tool, choose its risk, approve itself, invoke the native
bridge directly, or bypass an emergency stop.

## Components and disposition

### OmniController

The implemented OmniController is a main-process task owner rather than React
or WebContents state. It owns:

- one active task state machine;
- provider/model selection and capability validation;
- runtime-only task input and safe provider context;
- public task understanding, reasoning summary, plan, current/next step;
- Invisible/Cursor execution mode;
- Ask/Approve for me/Full approval mode;
- pause, resume, stop, and execution-mode transitions;
- tool-call cancellation and stale-call rejection;
- bounded Activity events and final report;
- optional completion speech through the injected TTS callback.

Focused controller tests verify serialized task start, visible plans, tool
routing, pause/resume/stop, execution-mode transitions, Modify Plan, Skip Step,
stale-call rejection after approval or intervention, abort propagation, safe
history, shutdown cancellation, failed-tool final-state checks, and pausing on
native pointer takeover. Cursor actions remain task-owned and mode-gated.

### Unified tool catalog

The repository keeps separate `workTools` and `codeTools` registries, including
colliding IDs such as `browser.open`. Omni now composes them without flattening
away their source authority. The implementation:

1. extends `AppMode` and tool validation to include `omni`;
2. injects the same PermissionManager into all mode registries/routers;
3. preserves existing Code and Work descriptors and tests;
4. resolves tool-ID collisions by source/mode rather than silently replacing
   executors;
5. exposes only connected, scoped, capability-compatible tools to the model;
6. routes Omni execution through the originating `ToolRegistry.execute`;
7. retains existing timeout, input/result-size, schema, access-level, and hard
   confirmation checks.

Omni and Work approval settings are composed to the stricter effective policy.
The task cannot lower the connector policy, and Full Access cannot bypass the
existing always-confirm/hard boundaries.

### Invisible Mode

Invisible is the default execution mode. It means work happens without visibly
driving the user's pointer; it does not mean unreported or unapproved work.

Implemented Invisible operations include authorized subsets of:

- Gmail and Drive connector calls;
- workspace, file, diff, Git, terminal, build/test, and dev-server tools;
- model and workspace-index queries exposed by registered tools;
- isolated Omni Managed Browser navigation and page inspection with visible
  presentation suppressed in Invisible mode;
- allowlisted application launch in the background when that satisfies the
  request.

Every executed operation produces bounded Activity metadata. Switching to
Cursor Mode is an explicit state transition and is rejected unless the helper
and Accessibility permission are ready. Invisible Mode never posts macOS mouse
or keyboard events.

### Cursor Mode

Cursor Mode adds a structured native ComputerTool beneath the same registry and
PermissionManager. Its detailed boundary is documented in
`OMNI_CURSOR_MODE.md`. Cursor Mode is not implemented by passing raw automation
scripts to a shell.

### Full Omni UI and overlay

Full Omni Mode is now a renderer surface that presents:

- implemented Idle, Planning, Waiting for Approval, Working, Speaking, Paused,
  Completed, Failed, and Stopped states; voice-input-only states remain reserved
  and honestly unavailable;
- typed request and assistant result;
- current task, public plan, current/next step, and progress;
- execution and approval modes;
- Pause, Resume, Stop, and mode switching;
- conversation history and redacted Activity.

The global overlay is a separate capability-limited window, not a second full
renderer with the complete preload API. It presents task status, public plan,
bounded Activity/result, typed input, core task controls, and Open in OmniCode.
`OMNI_BACKGROUND_SERVICE.md` defines its process and IPC boundary and records
the remaining post-quit helper work.

## Conversation and context

Omni retains bounded task summaries, public plan state, safe result summaries,
and redacted Activity under the application-support directory. Raw user input,
raw tool results, provider messages, API keys, OAuth tokens, authorization
headers, passwords, cookies, raw authentication data, microphone audio, and
screen captures are not stored in task history.

Natural references such as “open the newest one” are resolved from explicit
session entities. “This” context may use the current OmniCode selection,
workspace, managed page, or permission-scoped foreground application. If more
than one material target is plausible, the controller asks instead of guessing.

External content is untrusted context. Email, Drive documents, files, web pages,
Git data, terminal output, application labels, and screen OCR cannot alter the
system policy, user request, approval mode, or tool schemas.

## State machine and cancellation

The controller state is authoritative; UI animations are projections only.

```text
Idle -> Listening -> Transcribing -> Planning
Planning -> Waiting for Approval | Working | Failed
Working -> Using Cursor | Speaking | Paused | Completed | Failed
Using Cursor -> Paused (user takeover) | Working | Completed | Failed
Paused -> Working | Using Cursor | Failed/stopped
Completed/Failed -> Speaking -> Idle
```

Listening and Transcribing remain reserved until speech input exists. Using
Cursor is entered only while a real `computer.*` action runs; selecting Cursor
Mode alone does not fake that status. Completed/Failed/Stopped task records
remain terminal history; TTS is an interruptible completion side effect rather
than evidence that a task resumed.

The implemented Stop path:

- abort the provider request;
- reject queued and stale tool calls;
- invalidate the action generation so pending approvals and old tool calls
  cannot execute or resume the task;
- interrupt owned terminal/server work where policy permits;
- stop task speech output;
- preserve completed, reviewable changes and Activity evidence.

An execution generation belongs to every pending tool action. Results and
approval callbacks from an older generation are ignored and cannot resume work
after pause, plan change, skip, mode change, or Stop. A future native
ComputerTool must obey the same generation below the renderer.

## Settings and persistence

Omni settings are global user preferences, not workspace settings or renderer
`localStorage`. They are stored atomically with private file permissions and
strict validation. Invalid or corrupt data fails closed to:

- Omni disabled until explicitly enabled where appropriate;
- activation shortcut only;
- wake word off;
- Invisible execution;
- Ask approval;
- the validated default voice/rate/spoken-response settings (Omni itself remains
  disabled until explicitly enabled);
- screen observation off;
- no automatic background launch at login.

Provider credentials remain exclusively in Keychain. The model choice stores a
provider/model identifier only. Retention is applied at startup, after settings
changes, and when tasks reach terminal state; clearing history retains an
active task.

## Implementation phases and gates

### Phase 0 — contracts and regression harness — implemented

- `omni` contracts, settings schema, state types, and main-owned controller
  interfaces.
- One explicit PermissionManager authority and mode-aware tool
  catalog.
- Code and Work regression coverage remains in the shared suite.

Evidence: the current complete serial run passed 66 files with 559 tests and
one intentionally skipped native-Keychain file/test. TypeScript, the 3,121-
module production renderer, main/preload bundles, x86_64 Swift helper, and x64
directory package build pass. The packaged smoke verifies the embedded helper,
Cursor readiness, core workspace/PTTY/server/navigation paths, and zero renderer
errors.

### Phase 1 — Omni UI and text-only Invisible Mode — implemented foundation

- The third selector entry and purpose-built Omni surface are present.
- Model selection, planning, Code tools, and connected-app tools are reused.
- Main-owned pause/resume/stop and Activity are implemented.

Evidence: automated controller/router/permission tests cover the real registry
path, connector availability filtering, stricter approval composition,
cancellation, and no raw-result persistence. The built-app live smoke rendered
all three modes and verified a missing model is rejected clearly without
creating false task history. A configured-model task using each available
connector/tool family remains to be recorded before this phase is release-
complete.

### Phase 2 — resident global activation and overlay — implemented foundation

- The resident Electron process registers/unregisters the validated shortcut,
  can show a tray/menu-bar item, and lazily creates a dedicated overlay.
- The overlay uses a sandboxed dedicated preload and exact sender/channel
  allowlist. Native confirmation can be owned by the visible overlay or main
  window.
- Packaged login/background launch can initialize Omni without creating the
  main window or showing the Dock icon.

Evidence: a built-app live smoke enabled Omni, opened the overlay, confirmed
`window.omnicode` is absent and only the restricted `window.omniOverlay`
settings/tasks/activation groups are exposed, then reopened it with real
`⌘⇧Space` while another application was foreground. Remaining gate:
packaged login plus Finder/Safari/Chrome, another-Space, minimized/closed-main-
window, focus, and shortcut-conflict tests. Post-quit activation still requires
the helper work below.

### Phase 3 — voice and local wake phrase — TTS only

- Real macOS speech output, voice enumeration, stop, and task-completion speech
  are implemented through a fixed `/usr/bin/say` provider.
- Speech-to-text and wake-provider contracts exist, but no microphone provider,
  local wake engine, or capturing helper is shipped.

TTS evidence: provider lifecycle/redaction/cancellation tests, a real host voice
listing, and a built-app availability/voice-list query pass. Remaining gate:
real microphone, partial/final transcript, input interruption, audible packaged
TTS settings/task flow, offline wake, false-activation soak, and zero pre-wake
network traffic.

### Phase 4 — structured Cursor Mode — foundation implemented

- A separately bounded Swift helper, TypeScript adapter/session owner, eight
  `computer.*` tools, Accessibility readiness gate, direct approval for input,
  secret-text rejection, and user-takeover pause path are implemented.
- Both helper architecture targets compile; live read-only observation passed
  on the current host.

Remaining gate: safe-app live pointer/keyboard actions, semantic AX targeting,
native emergency stop, permission denial/revocation, signed package identity,
secure-field blocking, and real Apple Silicon runtime verification.

### Phase 5 — production packaging and feature freeze

- Sign nested native code, notarize, staple, and test both architectures.
- Run the full Code, Work, Omni, provider, Keychain, installer, and performance
  matrix.
- Declare feature freeze only after unresolved failures are recorded honestly.

## Principal regression risks

- Expanding `AppMode` affects renderer persistence, agent validation, every tool
  descriptor, and tests that assume exactly Code/Work.
- Merging registries can select the wrong `browser.*` executor unless routing is
  mode-scoped.
- Broadly relaxing the default session's deny-all permission handler could give
  web content microphone or screen access. Permission grants must be scoped to
  the exact trusted surface or handled natively.
- Current Code/Work tasks and approvals are renderer-owned and are cancelled on
  window close. Omni lifecycle work must not weaken their sender isolation.
- Eager main-process initialization defeats the lightweight background goal.
- Overlay focus changes can steal user keystrokes or break other applications.
- Native event injection and screen/audio capture create a larger privileged
  surface and must remain out of model and renderer reach.
- Unsigned rebuilds make stable TCC testing and helper identity unreliable.

## Current blockers and incomplete gates

- Apple Developer ID signing, notarization, and stapling credentials.
- Apple Silicon execution testing on matching hardware remains separately
  required even though arm64 artifacts can be produced.
- The CGEvent foundation exists, but no semantic AX/ScreenCaptureKit observation
  path, native emergency-stop event tap, or signed production helper exists yet.
- No bundled, licensed, measured local “Hey Omni” wake model exists yet.
- No native speech-to-text provider or microphone-capture lifecycle exists yet.
- No lightweight signed helper can activate Omni after an explicit application
  quit; the implemented shortcut/overlay require the Electron process to be
  resident or started by the packaged login/background path.
- The current Omni working tree passes the full serial suite, typecheck, and
  production build, but still needs configured-model tool E2E and packaged
  login/shortcut/overlay coverage before a release-readiness claim.

Until those items are implemented and verified, documentation and UI must not
claim global post-quit wake, voice input, semantic screen understanding, or
fully autonomous arbitrary computer control works. Real speech output,
resident-process overlay activation, structured Cursor commands, and live
read-only observation may be described only within their recorded limits.
