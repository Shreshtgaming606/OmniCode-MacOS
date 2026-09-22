# Omni Background Service and Overlay Architecture

Last updated: 2026-09-21

Status: **Resident-process global activation, restricted overlay, optional tray,
and packaged main-app background login launch are implemented; a lightweight
post-quit native helper is not implemented**

## Audited current lifecycle

`src/main/index.ts` now:

- acquires an Electron single-instance lock;
- eagerly constructs filesystem, terminal, Git, AI, connector, browser, and
  agent services at module load;
- creates the 1440x900 main BrowserWindow on ordinary launch, but packaged
  login/`--omni-background` startup initializes Omni without a main window and
  hides the Dock icon;
- keeps the process alive on macOS after the last window closes;
- keeps main-owned Omni tasks independent of the overlay renderer;
- registers/unregisters a validated global shortcut while Omni is enabled;
- creates/destroys an optional template-image tray/menu-bar item;
- lazily creates a dedicated sandboxed Omni overlay;
- applies the opt-in login setting through `app.setLoginItemSettings` in a
  packaged build;
- focuses the main window for a second instance;
- stops Code/Work/Omni tasks, TTS, terminals, browser sessions, approvals,
  servers, file watching, shortcuts, and tray state on quit.

The dedicated overlay uses its own `omni-overlay.html` renderer and
`omni-overlay.cjs` preload, exact window/main-frame/URL checks, and an explicit
channel allowlist. It can read settings and task state, start a typed task,
pause/resume/stop it, hide itself, and open the full Omni UI. It cannot invoke
general editor, filesystem, terminal, Git, browser, connector, application, or
credential APIs.

The remaining lifecycle gap is important: there is no `SMAppService` helper
bundle. The current login option registers the packaged main application and
detects macOS `wasOpenedAtLogin`; it is a background launch path, not a
lightweight native helper. Resident activation can work while the Electron
process is alive, but activation after `Command-Q` is not implemented.

## Target process model

Use two layers rather than keeping the complete editor UI alive:

```text
signed lightweight Omni helper (optional)
  - login item / SMAppService agent
  - owns local wake-word loop when enabled
  - owns global activation when full app is not resident
  - launches or signals the Electron app
  - no AI credentials, connectors, terminal, or filesystem tools

Electron main process / OmniBackgroundCoordinator
  - owns OmniController, ToolRegistry, PermissionManager, settings, task state
  - owns Electron global shortcut when helper is disabled and app is resident
  - lazily creates the compact overlay or full main window
  - initializes heavy AI/tool services only when a task or main UI needs them

sandboxed windows
  - full OmniCode renderer with existing typed API
  - capability-limited Omni overlay renderer
```

The helper is optional and defaults to disabled at login. Closing the main
window can leave the Electron coordinator active if Omni remains enabled.
Explicitly quitting the app stops the Electron process. Post-quit activation is
available only when the separately packaged helper is enabled and running.

## Phased background implementation

### Stage 1 — resident Electron coordinator — partially implemented

Implemented while the Electron process is running:

- register the shortcut after `app.whenReady()` and remove it on disable/quit;
- create the restricted overlay only on activation;
- keep task/controller state in the main process rather than the overlay;
- restore/show the full app and switch to Omni through “Open OmniCode”;
- optionally expose Activate/Open/Quit through a template-image tray item;
- detect packaged login or `--omni-background`, skip main-window creation, and
  hide the Dock while initializing settings, recovery, IPC, shortcut, and tray.

Not yet implemented in this stage:

- lazy construction of every heavy Code/Work service;
- a packaged cross-app/Space/closed-window focus audit;
- tested Dock visibility behavior for a background-only launch.

The implemented window/shortcut configuration is intended to support
foreground, minimized, another-Space, and closed-main-window activation while
Electron remains resident, but those packaged scenarios remain a recorded test
gate. It must not be described as working after the process is quit.

### Stage 2 — signed native helper — not implemented

Add a lightweight Swift `SMAppService` agent for:

- optional launch at login;
- global activation when Electron is absent;
- local wake-word monitoring when enabled;
- launching OmniCode into background mode;
- forwarding an activation reason;
- helper status and version reporting.

Electron 44 exposes service-aware `app.setLoginItemSettings`, but a real helper
service must be packaged and signed first. Registering the main app alone as a
login item does not keep activation alive after a manual quit.

The helper must not load Chromium, AI providers, Code/Work tools, browser
sessions, or user documents while idle.

## Global shortcut

Default: `CommandOrControl+Shift+Space` (`⌘⇧Space` on macOS).

The resident shortcut manager currently:

- consumes a length-bounded settings value that Electron validates at
  registration time;
- registers one Electron owner and records only a successful registration;
- unregisters the previous shortcut before replacement, on disable, and before
  shutdown;
- never intercept ordinary keys while Omni is idle;
- persists the validated value in the global main-process settings store.

Replacement conflict UX, a shortcut recorder, and a separate native emergency
stop chord remain test/implementation work.

Ownership rules:

- if the native helper is enabled and healthy, it owns the global shortcut;
- otherwise the resident Electron coordinator owns it;
- they must never both register and react to the same shortcut;
- helper failure may transfer ownership only through an explicit health/lease
  decision, not a race.

Global shortcut registration does not grant Accessibility or cursor-control
permission.

## Overlay window — implemented foundation

The overlay is a separate sandboxed, context-isolated BrowserWindow with a
dedicated preload. It is not the main app hidden at a smaller size.

Implemented window behavior:

- centered placement near the top of the active display;
- frameless premium macOS surface;
- always-on-top at an appropriate floating level while active;
- visible on relevant Spaces/full-screen Spaces;
- keyboard focus for its typed request and controls;
- dismissible with semantic keyboard-operable controls;
- task status, public plan, Activity/result, typed input, and controls;
- the shared theme vocabulary and a bounded responsive layout.

Collapsed/expanded presentation, waveform/listening state, multi-display bounds
reclamping, focus-theft measurements, and packaged accessibility verification
remain open gates. The current surface does not claim microphone capture.

The visual window is disposable. Its destruction must not cancel an authorized
main-owned task unless the user pressed Stop.

## Overlay IPC boundary — implemented

The main sender check remains restricted to `mainWindow.webContents`. A
separate overlay sender check and preload expose only:

- typed task activation;
- pause, resume, and stop current Omni task;
- dismiss;
- request Open in OmniCode;
- subscribe to sanitized task and Activity updates.

The overlay cannot directly call filesystem, terminal, Git, connector,
credential, browser, application, or ComputerTool IPC. It cannot choose tool
risk or forge a success event.

Every implemented overlay event verifies:

- exact trusted local URL and main frame;
- exact overlay WebContents identity;
- bounded schema and task/generation identity;
- current controller state;
- no navigation to remote content.

The full renderer and overlay observe the same main-owned task. Approval policy
remains main-process authoritative, with native confirmation owned by the
visible overlay or main window. Direct approval resolution is not exposed to
overlay JavaScript.

## Helper communication and identity

The native helper and Electron coordinator should communicate through
authenticated XPC or an equivalently scoped local channel. Requirements:

- verify code identity/team/bundle in signed production builds;
- restrict connection to the current user/session;
- no network listener;
- bounded versioned messages;
- monotonic activation/task generations;
- reject replayed or stale activation/control events;
- never send credentials, OAuth tokens, Keychain data, conversation contents,
  tool arguments, or screen/audio buffers through the helper channel;
- fail closed on protocol mismatch.

For local unsigned development, any fallback channel must use a private
application-support directory, restrictive permissions, unguessable session
authentication, and must never be presented as production-ready.

## Startup and lifecycle behavior

| Situation | Current disposition |
| --- | --- |
| Normal app launch | Implemented: main UI is created; persisted Omni shortcut/tray/login settings are applied |
| Main window closed | Electron remains resident on macOS; packaged closed-window shortcut/overlay behavior still needs E2E evidence |
| App minimized/another Space | Overlay is configured for all/full-screen Spaces; cross-app packaged activation/focus testing remains |
| Login option | Implemented: packaged main-app login/background startup initializes Omni without a main window or Dock icon; a lightweight native helper is not implemented |
| Shortcut with Electron absent | Not implemented; requires the native helper |
| Hey Omni with Electron absent | Not implemented; no wake engine/helper |
| Open in OmniCode | Implemented: creates/shows main window and queues Omni activation until the renderer is ready |
| Explicit Quit | Implemented cleanup stops shortcut, tray, tasks, TTS, browsers, terminals, approvals, servers, and watchers |
| Screen lock/logout | No mic/cursor capture exists; explicit task pause/failure policy still requires lifecycle integration |
| Crash/restart | Implemented store recovery marks stale nonterminal tasks stopped; no action is resumed automatically |

The Quit wording/menu must make helper behavior understandable. The user must
have a direct “Quit OmniCode and Omni helper” path.

## Menu-bar integration — implemented foundation

The menu-bar item is optional and disabled by default. While Electron is
resident it uses a template image and a bounded menu.

Implemented items:

- Show Omni
- Open OmniCode
- Quit OmniCode

Execution mode, microphone/wake status, Pause Wake Word, and helper-only quit
items remain future work because those native subsystems are not present.

Disabling the menu item must not silently disable the configured shortcut; the
two settings are independent and clearly labeled.

## Resource budget — not yet measured for Omni

The release target remains that idle background operation must not:

- create a renderer or Managed Browser;
- load a cloud provider or make provider requests;
- run workspace indexing;
- create terminal PTYs;
- capture screens;
- run general speech recognition;
- start a large local model;
- poll Gmail/Drive;
- keep microphone capture active when wake phrase is off.

An Omni-specific idle CPU/memory/wakeup/energy measurement has not yet been
recorded. Wake-word measurements cannot begin until a real local engine exists.

## Permissions

The helper requests only capabilities the user enabled:

- shortcut only: no microphone, speech, screen, or Accessibility permission;
- wake phrase: microphone, with local detection disclosure;
- voice transcription: microphone and Speech Recognition as applicable;
- Cursor Mode: Accessibility and screen observation only when needed.

Permission prompting belongs to onboarding/settings/action enablement, never to
an unconditional first application startup.

## Packaging

Production packaging must include:

- helper executable/service metadata in the correct app-bundle location;
- stable bundle/service identifiers;
- helper and main entitlements;
- microphone and Speech Recognition usage descriptions where relevant;
- architecture-correct x64 and arm64 binaries;
- nested-code signing in the correct order;
- Developer ID signing, notarization, and stapling;
- upgrade/removal behavior that does not orphan an old helper;
- version compatibility between helper and main app.

`package.json` currently has no helper or explicit entitlements configuration.
The existing unsigned installers cannot validate the public helper lifecycle.

## Test gates and evidence

### Automated — passing where implemented

- settings validation, corruption recovery, fail-closed defaults, and updates;
- strict overlay channel/window/main-frame/URL design enforced in main-process
  handlers and a dedicated minimal preload;
- task/action generation invalidation and replay/stale-call rejection;
- controller cleanup on stop and application quit;
- separate preload and renderer entries included in the production build;
- packaged-only background-launch detection, login-item settings, explicit
  argument handling, and development-visible fallback.

Shortcut conflict/replacement behavior, collapsed/expanded focus transitions,
helper ownership/protocol, and screen-lock behavior do not yet have complete
automated coverage.

The current complete serial run passed 66 files with 564 tests and one
intentionally skipped native-Keychain file/test. A built-app live smoke verified that the
overlay exposes only `window.omniOverlay`, reopened via real `⌘⇧Space` while
another application was foreground, and preserved the main-process boundary.

### Packaged real-world

- `⌘⇧Space` from OmniCode, Finder, Safari, Chrome, another app, another Space,
  minimized state, and closed main window;
- shortcut conflict with an occupied accelerator;
- compact overlay without unnecessary focus theft;
- keyboard navigation and Open in OmniCode handoff;
- helper disabled, enabled, login, logout, manual quit, and update;
- screen lock/unlock and multi-display removal;
- idle and wake-enabled energy soak;
- no background provider/network work while idle;
- signed/notarized Intel and Apple Silicon bundles.

## Current blockers and incomplete gates

- No native helper project or local wake engine exists.
- The packaged main app, rather than a lightweight helper, owns the implemented
  login/background path and still constructs the broader Electron service set.
- Resident shortcut, tray, and overlay need packaged cross-application,
  login, another-Space, minimized, closed-main-window, focus, and conflict
  testing beyond the current built-app cross-application shortcut smoke.
- Overlay collapse/expand presentation and multi-display rebounding remain
  unimplemented.
- Developer ID signing/notarization is unavailable.
- Apple Silicon helper execution needs matching hardware verification.

Until the helper gate passes, documentation and UI distinguish “available while
OmniCode is running” from “available after OmniCode is completely quit.”
