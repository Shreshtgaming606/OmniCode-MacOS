# OmniCode Stabilization Changelog

This log records repairs and audit milestones made during the no-new-features
stabilization phase.

## Omni text-first assistant foundation — 2026-09-21

- Added Omni as the third persistent Code / Work / Omni mode, with validated
  preferences and a purpose-built UI for provider/model selection, typed
  requests, public plans, bounded Activity, results, task history, permissions,
  Pause/Resume/Stop, Modify Plan, Skip Step, and execution/approval controls.
- Added a main-process `OmniController` that reuses the provider-neutral Work
  tool loop, serializes task start, owns AbortControllers and action generations,
  rejects calls made stale by approval wait, pause, plan/step changes, mode
  changes, or Stop, and stops every active task during application shutdown.
- Locked the approval selector while an Omni task is active and display the
  immutable approval policy captured on that task. Changing a future global
  default can no longer create a misleading authority display for running work.
- Added private atomic Omni settings and task stores with fail-closed defaults,
  corruption recovery, Full Access acknowledgement, bounded retention, startup
  recovery, user clearing that preserves active work, and redaction. Raw user
  requests and generic raw tool results are not persisted.
- Unified Code, Work, and Omni under one injected Permission Manager while
  preserving source-scoped registry execution. Omni and connector approval
  policy now compose to the stricter mode; connected-app schemas are exposed
  only when the connector is connected and the required scopes exist.
- Added a dedicated Omni Managed Browser with its own persistent session
  partition and mode-aware focus behavior. Invisible mode does not show the
  managed page or foreground allowlisted app launches, and no behavior is
  misrepresented as native macOS cursor control.
- Added a separate sandboxed overlay renderer/preload with exact window,
  main-frame, local-URL, and channel allowlists. It can observe/start/control
  Omni tasks but has no full `window.omnicode`, tool, credential, filesystem,
  terminal, Git, browser, connector, or application API.
- Added resident `⌘⇧Space` activation, an optional menu-bar item, and
  packaged login/background startup that initializes Omni without a main window
  or Dock icon. A native post-quit helper remains unimplemented.
- Added real macOS TTS using fixed `/usr/bin/say` without a shell: installed
  voice discovery, bounded/redacted stdin text, safe voice/rate validation,
  embedded-command stripping, output bounds, cancellation, Stop, concurrency,
  and disposal. Microphone/STT and local wake remain honestly unavailable.
- Fixed task-start races, stale post-approval actions, raw tool-result history,
  dead retention paths, stale restart state, disconnected connector exposure,
  browser-session collisions, and Invisible-mode foreground focus.
- Hardened every model-driven terminal command and terminal-input tool to
  require non-bypassable direct approval even in Full Access. Agent PTYs now
  skip login/rc files and inherit only an allowlisted toolchain/locale
  environment with cloud credentials and authentication sockets stripped.
- Added a structured native Cursor Mode foundation: strict shared contracts, a
  fixed Swift CGEvent helper, task-owned sessions, helper/Accessibility
  readiness, eight mode-gated `computer.*` tools, active-display and input
  bounds, direct approval for click/type/key actions, secret-text refusal,
  cancellation/timeout, pointer takeover pausing, and cleanup. Both x86_64 and
  arm64 helper targets compile; live read-only native observation passed.
- Separated public and localhost Managed Browser sessions, destroyed stale page
  state on scope changes, bound loopback sessions to one exact origin, and
  removed public DNS caching at the security decision boundary.
- Added recursive bounded sanitization for all model-visible tool results,
  including sensitive containers, authorization/cookie headers, credential URL
  parameters, provider/service token forms, and private keys.
- Prevented a provider's optimistic final text from marking an Omni task green
  when the latest observed tool outcome is failed or cancelled.
- Refreshed Omni cloud model selection to use authenticated provider catalogs
  for OpenAI, Anthropic, and Gemini while retaining inspected local Ollama
  models.
- The current complete serial suite passes 66 files with 559 tests and one
  intentionally skipped native-Keychain file/test. TypeScript, the 3,121-module
  production build, x86_64 native helper, and x64 directory package pass. A built-app live smoke rendered Code/Work/Omni, verified the
  restricted overlay boundary, reopened it with real `⌘⇧Space` while another
  app was foreground, queried real TTS availability/voices, and confirmed a
  missing model fails clearly without creating task history.
- Extended the packaged smoke to reopen an explicitly authorized workspace
  before filesystem access and to verify the packaged Omni helper, real
  Accessibility readiness, TTS availability, accurate Cursor-option state,
  native PTY, localhost secret boundaries, navigation blocking, and zero
  renderer errors. This removed noisy false failures from the old fresh-profile
  harness without weakening the workspace authorization boundary.
- After approval-display, agent-terminal, model-result, browser-isolation, and
  native-Cursor hardening, the complete serial suite and focused TypeScript
  checking pass.

## Omni Mode audited architecture baseline — 2026-09-15

- Audited the complete third-mode specification against the current Electron,
  Code Agent, Work connector, Tool Registry, Permission Manager, browser,
  application-launch, lifecycle, IPC, and packaging implementations.
- Added permanent Omni architecture, voice, Cursor Mode, background service,
  and security documents that distinguish current 0.5.1 behavior from phased
  targets and test gates.
- Recorded the honest starting gaps: no global hotkey/overlay/helper, voice or
  local wake detector, and no structured arbitrary macOS computer control.
- Defined reuse of the existing provider/tool/permission stack without a second
  AI implementation, plus fail-closed native, permission, privacy, signing,
  and regression gates for implementation.

## OmniCode 0.5.1 Agent plan and reasoning summary — 2026-09-15

- Added a bounded, provider-neutral `agent.update-plan` tool for Code Agent task
  understanding, concise Reasoning Summary, assumptions, ordered steps,
  progress, current/next step, decisions, and explained plan changes. The
  schema explicitly excludes provider-private reasoning and system prompts.
- Added a compact Agent Plan surface shared by Standard and Glasses modes with
  progress, expandable details, step state, decisions, assumptions, and a clear
  privacy label. Standard retains consequential plan/test/build/result events;
  Glasses additionally retains every meaningful observable tool action.
- Added Modify Plan and Skip Step controls. User interventions pause at a safe
  action boundary, are delivered to the model before further work, and cause
  already-proposed stale calls to be returned as skipped rather than executed.
- Kept plan metadata outside execution authority: every actual action still
  uses the existing Tool Registry and Permission Manager. Approval and
  visibility remain independent, and task/sender ownership is enforced by the
  main process.
- Added Action / Reason / Result pairing to Glasses events. Explicit terminal
  rationales are preserved; other actions receive a bounded reason tied to the
  visible current plan step.
- Added a final task report derived from persisted evidence: What I did, What
  changed, Tests performed, Results, Problems encountered, Plan changes, and
  Remaining issues. Missing evidence is labeled as unrecorded rather than
  implied to have passed.
- Expanded persistent task validation/redaction for plan fields and added
  backwards compatibility for 0.5.0 tasks without plan state.
- Added regression coverage for initial/changed/progress plans, decisions,
  assumptions, persistence, redaction, Standard/Glasses filtering, final
  reports, Modify Plan, Skip Step, stale-call cancellation, pause/resume, and
  provider-neutral execution. The full suite passes with 459 tests and one
  intentionally skipped native Keychain test.
- A packaged Intel audit used a loopback-only controlled Ollama-compatible
  service to exercise five real provider turns, both intervention controls,
  safe pause/resume, dynamic plan revisions, a real runtime-detection action,
  final reporting, Standard/Glasses differences, layout bounds, and renderer
  logging. The stale proposal did not execute; zero renderer errors occurred.
- Built fresh 0.5.1 Intel and Apple Silicon DMG/ZIP artifacts. Both architectures
  contain matching Electron/native PTY slices, embed 0.5.1, preserve the
  original icon, and pass ZIP/DMG/checksum verification. The Intel package ran
  the live audit; Apple Silicon launch and Apple signing/notarization remain
  external requirements.

## OmniCode 0.5.0 Code Agent and Glasses Mode — 2026-09-14

- Replaced Code Mode's renderer-only, one-response planning flow with a real
  main-process Code Agent controller that reuses the existing provider-native
  Work tool loop, Tool Registry, and Permission Manager.
- Added registered Code tools for bounded workspace inspection, diff-backed
  file changes, task-owned interactive PTYs, real build/test output and exit
  status, structured Git operations, runtime detection, development servers,
  a dedicated Code Browser, and allowlisted macOS application launch.
- Added one-task external-folder grants through a native picker. The agent sees
  only an opaque grant and folder label; traversal, symlink escape, private
  configuration, credentials, protected system roots, binary context, and
  cross-task reuse are rejected.
- Added Code Browser public-web search, HTTPS documentation navigation,
  localhost HTTP/HTTPS testing, visible-page reading/find, reload, console
  errors, and bounded safe click/type. Work Browser's stricter public-HTTPS-only
  boundary remains unchanged.
- Added Standard and Glasses visibility independently from Ask, Approve for me,
  and Full Access. Glasses shows observable actions, commands, bounded output,
  diffs, pages, application launches, approvals, failures, retries, and final
  results without exposing or claiming hidden chain-of-thought.
- Added Automatic/When needed/Never focus control, live task state,
  pause/resume, Take Over, stop, and bounded persistent Activity history. Stop
  aborts future work and owned processes while preserving completed edits.
- Added a private atomic Code activity store with redaction, corruption
  recovery, and hard task/event/byte limits; raw prompts and workspace roots are
  not persisted.
- Hardened terminal policy against privilege escalation, Keychain/credential
  discovery, secret environment expansion, arbitrary AppleScript, nested
  evaluation shells, remote transfer tools, global installs, and destructive
  system commands. Project dependency commands have a separate allowlist and
  always require direct approval.
- Added honest macOS Accessibility and Screen Recording status plus exact System
  Settings links. Arbitrary app UI control remains explicitly unavailable until
  a safe native ComputerTool exists; OmniCode does not use unrestricted shell
  automation as a substitute.
- Fixed Google Code Agent defaults after a real request proved Gemini 2.5 Flash
  unavailable to new users. Discovery now prioritizes current `latest` and 3.6
  models; actual provider errors and quota limits remain visible.
- A packaged 0.5.0 Gemini task inspected a real file, made an exact diff-backed
  write, read it back, completed, and rendered a five-event Glasses timeline
  with its final result and Review Diff action. A subsequent provider call hit
  the real five-request account quota and failed honestly. Automated
  coverage is 454 passing tests plus one intentionally skipped native Keychain
  test; TypeScript and production compilation pass.
- Added `OMNICODE_CODE_AGENT_ARCHITECTURE.md` and the permanent phased baseline
  plan documenting execution, visibility, permissions, security, and verified
  limitations.
- Built fresh x64 and arm64 DMG/ZIP artifacts. All four pass checksum and archive
  verification; both apps embed version 0.5.0, preserve the original icon hash,
  and contain matching executable/native-terminal architecture. The Intel
  package passed startup/workspace, real PTY, localhost/security, Agent/Glasses,
  and zero-renderer-error checks. Signing/notarization and arm64 execution remain
  external requirements.

## OmniCode 0.4.0 Work action approvals — 2026-09-13

- Evolved the existing main-process `PermissionManager` into a complete Work
  action policy with **Ask for approval**, **Approve for me**, and **Full access**
  modes. Missing, corrupt, and migrated settings fail closed to Ask.
- Added global and per-connector permission controls to Work Mode and Settings,
  including a dedicated first-use Full Access warning. The backend refuses an
  unacknowledged Full Access change rather than trusting the renderer alone.
- Added explicit application-owned category, risk, reversibility, and external-
  side-effect metadata to all Browser, Gmail, and Drive tools. The backend
  dynamically escalates bulk and credential-bearing inputs to critical risk.
- Kept critical, financial, account-security, irreversible destructive, and
  explicitly always-confirm actions behind direct approval in every mode.
  Connector scopes, read-only access, schema checks, and network boundaries
  remain independently enforced.
- Added a polished, sender-bound Work approval card with bounded exact action
  details, safe-focus Cancel, Approve once, abort/navigation cleanup, a five-
  minute timeout, and a native macOS fallback when the renderer is unavailable
  or already displaying another approval.
- Added private, atomic main-process permission and action-history stores. The
  bounded local activity log records only redacted operation metadata and never
  tool inputs, recipients, content, model output, credentials, or tokens.
- Applied the same Tool Registry and Permission Manager path to OpenAI,
  Anthropic, Gemini, and compatible Ollama tool turns. Prompt-injection strings
  from messages, Drive files, webpages, and model output cannot lower policy.
- Verified a packaged Intel build against the connected Google test account:
  a harmless Gmail labels read ran automatically, an exact Gmail-send approval
  rendered, Cancel prevented the network write, Activity recorded the cancelled
  action, original permission settings were restored, and no renderer error was
  captured.
- Expanded the automated regression suite to 419 passing tests with one
  intentionally skipped native Keychain test and no failures. TypeScript and
  production compilation pass. Fresh 0.4.0 x64/arm64 DMGs and ZIPs pass archive,
  image, version, executable/native-module architecture, original-icon, and
  SHA-256 verification; the x64 package passed final runtime smokes.
- Documented the complete security model, mode behavior, connector policy,
  storage/privacy boundary, and test evidence in
  `OMNICODE_WORK_ACTION_APPROVALS.md`.

## OmniCode 0.3.1 Google OAuth publisher integration — 2026-09-13

- Added a strict build-time loader for a publisher-owned Google Desktop OAuth
  credentials JSON. The ignored local file is bounded and schema-validated;
  matching Desktop public-client metadata enters only the trusted main bundle.
- Treated the downloaded Desktop `client_secret` as extractable compatibility
  metadata, never as a confidential server-side credential or security boundary.
  Authorization and refresh use it only where expected by Google's endpoint and
  retain Authorization Code flow with PKCE S256, random state, and a random
  loopback callback.
- Added explicit ignore rules and a safe `.env.example` for developer-only OAuth
  build inputs. The supplied local credentials file was restricted to mode
  `0600`; automated comparison confirmed its raw JSON and absolute path are
  absent from compiled output and tracked source.
- Unified Gmail and Google Drive authorization into one shared Google account
  consent flow and shared status summary in Work Mode and Settings. Normal users
  see only account connection language, never client files or Google Cloud
  setup instructions.
- Fixed a live-test bug that erased Google authorization timeout, cancellation,
  test-user, and configuration failures during the post-connect service refresh.
  The shared manager now retains the sanitized failure across both Google cards
  until a successful retry or disconnect.
- Added developer Testing-mode guidance for an account that is not authorized as
  an OAuth test user without exposing that publisher-only wording in production
  builds.
- Added `GOOGLE_OAUTH_PRODUCTION.md` with the testing/production project split,
  consent configuration, verification, Restricted Scope, data-disclosure,
  security-assessment, signing, and release-checklist requirements.
- Expanded the automated suite to 403 passing tests with one intentionally
  skipped native Keychain test; TypeScript checking and production compilation
  also pass.
- Rebuilt and launched an isolated 0.3.1 x64 package during validation. After
  the account was approved as a test user, the real system-browser consent and
  token exchange completed, both Gmail and Drive reported the same verified
  shared account, and the grant remained connected after a full app restart.
- Fixed the real Google Desktop token exchange after the first approved consent
  reached `invalid_request`: OmniCode now sends the matching extractable Desktop
  client metadata during authorization-code exchange and refresh while retaining
  PKCE as the authorization-code protection boundary.
- Performed minimal read-only live API checks through the packaged app. Gmail
  returned a valid label array and Drive returned a valid empty result for a
  deliberately impossible query; the audit printed only counts and changed no
  mailbox or Drive data.

## OmniCode 0.3.0 release-candidate verification — 2026-09-13

- Added integrity-checked opaque Work transfers so Gmail attachments can move
  to Drive and Drive files can move into Gmail drafts without exposing bytes,
  base64, transfer capabilities, or local paths to the model. Native downloads
  use an actual macOS Save dialog and return only safe filename/size metadata.
- Expanded Gmail to 13 real tools and Google Drive to 15 real tools, including
  bounded threads, HTML-only mail fallback, MIME/header-injection defenses,
  exact attachment transfer, Google document export, binary-context refusal,
  folder/file mutations, network error mapping, and request cancellation.
- Added four multi-turn Work-agent integration workflows for Gmail attachment to
  Drive, Drive file to Gmail draft, Gmail summary, and Drive analysis. All four
  passed their confirmation, byte-integrity, and model-boundary assertions.
- Added trusted, bounded Gmail/Drive/file result projections and polished Work
  result cards. Dark and compact-light packaged smokes verified persistence,
  reload, readable content, zero internal-ID leakage, and zero renderer errors.
- Added Connected Apps permission-management links and keyboard dismissal while
  preserving honest connected, disconnected, and externally blocked states.
- Fixed Google OAuth deployment configuration so a publisher client can be
  embedded in the trusted production main bundle for Finder launches. Runtime
  overrides remain supported and cannot accidentally combine one client ID with
  another client's secret. The current build intentionally remains unconfigured
  until a registered publisher client is supplied.
- Repaired the fresh-profile startup soak so first-launch onboarding is measured
  rather than misreported as a workbench timeout. Three packaged x64 cycles
  passed startup, idle-resource, quit, and helper-cleanup bounds.
- Expanded the automated suite to 395 passing tests with one intentionally
  skipped native Keychain test and no failures. TypeScript and both production
  architecture builds pass.
- Built OmniCode 0.3.0 Intel and Apple Silicon DMG/ZIP artifacts. Both ZIPs fully
  decompress, both DMGs verify and mount, embedded versions and executable/native
  terminal architectures match their labels, and packaged icons remain byte-
  identical to the original `build/icon.icns`.

## UI/UX and Google Workspace integration — 2026-09-09

- Established `OMNICODE_DESIGN_SYSTEM.md` as the shared visual, motion,
  accessibility, and component-state contract for Code and Work modes.
- Reconfirmed the expansion baseline on `codex/work-mode`: the worktree was
  clean at `4fe1e0c`; 350 automated tests passed, one native Keychain test was
  intentionally skipped, and no test failed before this phase began.
- Audited the existing Google boundary. Gemini API-key support is present, but
  Gmail/Drive OAuth, Workspace tokens, and service tools do not yet exist;
  connector UI must therefore remain honestly disconnected until a registered
  Google desktop OAuth client and user consent are available.
- Added the shared main-process Google OAuth account foundation: system-browser
  loopback authorization, PKCE S256, anti-CSRF state validation, OAuth code
  exchange, account verification, access-token refresh, revocation, and a
  verified macOS Keychain record whose secret bytes never enter process argv.
- Registered honest Gmail and Google Drive connector adapters. They report the
  exact missing-client, missing-scope, expired-authentication, network, rate
  limit, unavailable, and verified-account states; registration alone never
  produces a Connected state.
- Added main-process Gmail REST tools for bounded search, message/thread/text-
  attachment reads, labels, drafts, send/reply, read state, archive, and label
  changes. Send and reply are always confirmed with exact recipients, subject,
  and body before the first network write.
- Added main-process Drive REST tools for search, recent/folder lists, metadata,
  bounded text reads, Google Docs/Sheets/Slides export, text upload, folder
  creation, rename, move, copy, trash, and restore. Binary content is never
  blindly injected into AI context and every write passes the permission layer.

## Work Mode expansion — 2026-09-09

- Began a new expansion phase on `codex/work-mode` after the 0.1.1 stabilization
  checkpoint. Work Mode is explicitly separate from the existing Code Mode.
- Audited the renderer, AI/model, Git/import, Keychain, IPC, security, and
  documentation architecture before implementation.
- Recorded the mode, conversation, model-catalog, tool, connector, permission,
  Browser, OAuth, and repository-import boundaries in
  `OMNICODE_WORK_MODE_ARCHITECTURE.md`.
- Added a persistent Code/Work mode switch while keeping the complete Code
  workbench mounted, so editor buffers, terminals, Git and servers survive mode
  changes.
- Added private atomic Work conversation persistence with bounded CRUD, search,
  rename, pin, delete, message editing, regeneration, recovery, and mode-`0600`
  storage.
- Added bounded account-visible cloud model discovery, pagination, caching,
  stale/error states and refresh for OpenAI, Anthropic and Gemini, plus inspected
  Ollama metadata. Replaced raw cloud model fields in Work, Code Chat and
  Settings with real selectors.
- Added native OpenAI/Anthropic/Gemini/Ollama streaming and cancellation for
  Work Mode. A live packaged Gemini 3.7 request streamed the exact expected
  response; Stop preserves an honest cancelled partial response.
- Completed the trusted main-process Tool Registry, Permission Manager, and
  Connector Manager. Mode, connector, scope, schema, action, timeout, result
  bounds and confirmation policies are enforced outside React.
- Added the isolated read-only Managed Browser connector. HTTPS/DNS/private-
  network, redirect, popup, download, protocol and permission protections have
  regression coverage; the packaged connector opened, read and searched the
  real Example Domain page, then disconnected cleanly.
- Fixed Gemini tool calling by removing unsupported schema keywords and
  retaining provider thought signatures/call metadata; fixed Ollama's tool turn
  wire format. A live Gemini 3.7 Work agent completed a real browser tool turn.
- Fixed the local-model capability boundary so unknown, unsupported, or
  uninstalled Ollama models remain chat-only even when apps are connected.
- Added private Work attachment import for bounded text/source files using
  opaque IDs and controlled copies. Live Markdown context reached Gemini while
  the original path stayed out of persisted conversation metadata; unsupported
  binary/rich formats fail honestly.
- Added Open Existing Repository entry points and sanitized inspection, plus
  real clone progress, final exit state, cancellation, URL validation, and a
  polished modal. Real completion, cancellation, and invalid-URL workflows
  passed without fake success or raw stderr leakage.
- Added Work Mode and Connected Apps Settings sections with real connector
  state/actions. OAuth-dependent Google/Microsoft/Discord connectors remain
  blocked until registered desktop OAuth clients and user consent exist.
- Added `scripts/smoke-work-mode.mjs` and passed the packaged 0.2.0 Intel smoke:
  separate surface, Code preservation, conversation persistence, browser tools,
  live Gemini streaming, cleanup, and zero renderer errors.
- Expanded the automated suite to 350 passing tests with one intentionally
  skipped native Keychain test; TypeScript and the full production build pass.
- Built OmniCode 0.2.0 Intel and Apple Silicon DMG/ZIP artifacts. Both DMGs
  verify and mount, both ZIPs decompress, architecture/native-module slices and
  embedded versions match, and the packaged icon is byte-identical to the
  original `build/icon.icns`.

## 2026-09-08

- Rebuilt the final OmniCode 0.1.1 Intel and Apple Silicon DMG and ZIP artifacts
  from the stabilized production source. Both ZIP archives passed full
  decompression tests, both DMGs mounted and verified their internal checksums,
  and the app plus active `node-pty` modules matched their x86_64/arm64 labels.
- Re-ran the final Intel packaged smoke against the release candidate. Startup,
  workspace IPC, a real zsh PTY, localhost public/secret boundaries, blocked
  external navigation, and zero renderer errors passed.
- Re-ran the real custom execution pipeline and captured Run Log against the
  final package. Pre-run, build, command, post-run, space-containing working
  directory, environment, and exit code 0 all matched exact output.
- Completed a final credential-leak audit across 143 repository files, 30 files
  in the isolated packaged profile, 10 workspace files, renderer local storage,
  and visible diagnostics. No unexpected credential-shaped value was found and
  no Keychain credential was read or printed.
- Split synthetic token-shaped redaction fixtures so repository secret scanning
  does not confuse deliberate test data with stored credentials; all five
  diagnostic logger regression tests still pass.
- Generated fresh SHA-256 checksums for all four 0.1.1 release artifacts and
  recorded final release readiness separately.

## 2026-09-07

- Completed the Explorer context-menu lifecycle in the packaged app: actual New
  Folder, New File, Rename, Duplicate, and Move to Trash controls produced exact
  filesystem state for spaces, Unicode, and periods. Three styled input dialogs
  and four native confirmations completed with exact duplicate bytes, full
  disposable cleanup, and zero renderer errors.
- Replaced the misleading `Debug`/`Debug Console` label with `Run Log`. The
  panel still captures real task output, now without implying that OmniCode has
  a debugger adapter; a packaged custom task populated the relabeled panel with
  the exact real pre/build/run/post output and exit code.
- Fixed a startup race that could discard native menu or Finder commands sent
  between the first renderer paint and React's command subscription. The
  preload now attaches its IPC listener immediately and drains a bounded,
  ordered startup queue when the renderer subscribes; three regression tests
  cover ordering, live delivery/unsubscribe, and queue bounds.
- Exercised the Setup install UI itself in the rebuilt package. Command Palette
  opened Setup, the Programming Runtimes step rendered an enabled `Install Go`
  action, the native Install/Cancel sheet appeared, and Cancel started no
  installer or progress, left Go absent, returned to the workbench, and emitted
  no renderer error. Invalid tool identifiers still fail before a dialog.
- Fixed five user-visible actions that depended on Electron's unsupported
  `window.prompt()`: Clone Repository, New Project, Create Branch, Delete
  Branch, and Rename Terminal. They now share the existing styled input modal
  with dialog semantics, autofocus, empty-input protection, Escape/Cancel, and
  backdrop dismissal.
- Verified those repaired dialogs against real operations in the rebuilt app:
  cloned a local bare repository through the native destination picker and
  matched its origin, created/deleted a branch, renamed the live terminal, and
  created an exact Unicode/space-named project directory. Escape cancellation
  opened no picker and all fixtures were removed. Native confirmation support
  was also observed separately.
- Added a centralized, bounded main-process diagnostic log for lifecycle and
  failed IPC operations. Records contain timestamp/subsystem/operation/category,
  rotate at 512 KiB, use mode `0600`, refuse symlinks, and redact provider keys,
  tokens, authorization fields, and URL credentials without ever logging IPC
  arguments, request bodies, file contents, or stack traces. Five unit tests and
  a real rebuilt-package permission failure passed.
- Verified custom Run configuration in the packaged UI: a disposable
  `.omnicode/settings.json` overrode the automatic JavaScript recipe, executed
  preRun/build/run/postRun in order, preserved an exact space-containing cwd and
  custom environment, and exited 0 before cleanup/restoration.
- Audited runtime-install authorization and failure behavior. The real Setup
  `Install Go` action exposed native Cancel and started no process/progress; an
  invalid tool ID failed before a dialog, and a separate real missing-Go attempt
  surfaced Homebrew's non-writable-folder failure without claiming success or
  leaving Go/a package process installed.
- Exercised a live model-generated Agent command request with bounded retries.
  Gemini returned repeated `fetch failed` transport errors; OmniCode displayed
  the failure, proposed/executed nothing, left no marker, and the audit restored
  its temporary confirmation override. A later retry on Google's API-recommended
  Flash-Lite replacement produced exactly one command-only plan; Review & Run,
  native approval, workspace PTY execution, exit code 0, exact bytes, and full
  cleanup all passed with zero renderer errors.
- Verified Recent workspace persistence through a real app restart without a
  launch path. The exact canonical folder rendered in Welcome, reopened from
  its UI button, and loaded a real 10-entry tree before graceful cleanup.
- Re-ran the expanded suite after diagnostics: 244 tests passed, one native
  Keychain test remained intentionally skipped from the normal run, TypeScript
  and the production bundle passed, and the rebuilt x64 package recorded the
  expected redacted permission diagnostic.

- Verified native system clipboard behavior in the packaged editor and terminal,
  restoring the user's previous clipboard without logging it. Monaco inline
  Replace All, exact saved bytes, 1,520-row terminal scrollback, and terminal
  copy/paste all passed with zero renderer errors.
- Verified the real native Agent command approval boundary. Cancel returned
  false and made no filesystem change; Run Command returned true and only the
  approved safe command executed in the authorized workspace PTY.
- Verified default-browser launch and actual live reload: OmniCode opened Chrome
  on its selected localhost port, and the same tab automatically changed to the
  exact edited HTML title and heading before the server stopped and released the
  port.
- Replaced plain assistant `<pre>` output with safe Markdown rendering, inert
  raw HTML, and HTTPS-only external-link handling. A real packaged Gemini reply
  rendered a heading, list, inline code, and fenced JavaScript block; New Chat
  cleared it and no renderer error occurred.
- Updated the earlier live AI-context audit selectors for the repaired Markdown
  DOM and added a repeatable packaged Markdown audit.
- Verified terminal workspace switching end to end. Folder drop replaced the old
  PTY, the new shell printed its exact canonical `pwd`, stale-session input was
  ignored, and restoring the original workspace created another correctly rooted
  session.
- Verified an externally moved workspace during a dirty edit fails visibly
  without clearing the buffer or changing the original disk bytes, then recovers
  after the path/workspace is restored.
- Added a credential-leakage audit across repository, isolated profile,
  workspace, renderer local storage, output/toast/error/terminal text, and
  Keychain presence booleans. It found no unexpected credential-shaped values,
  explicitly permits only one known synthetic redaction fixture, and never reads
  or prints a credential value.
- Verified the real native folder picker: Open exposed Open/Cancel/New Folder,
  selected and authorized an exact disposable directory, Cancel preserved the
  current workspace, and a second native selection restored the original path.
- Verified notification input validation in the package. A valid bounded request
  was accepted and empty/oversized variants were rejected; the native banner is
  externally blocked because macOS/Electron do not deliver notifications from an
  unsigned development build.
- Re-ran the complete suite after the Chat repair: 239 tests passed, one native
  Keychain test remained intentionally skipped from the normal run, TypeScript
  passed, the x64 production directory rebuilt, and zero tests failed across 24
  files.

- Fixed accelerated workspace search so positive include globs cannot re-enable
  default or explicit exclusions, and `.gitignore` works in non-Git folders.
- Fixed automatic/manual same-workspace indexing races by coalescing concurrent
  requests instead of returning stale status from a canceled generation.
- Added regression tests for both failures and a packaged performance soak with
  exact ignore/result checks.
- Verified a 1,203-file packaged workspace opened in 415 ms, indexed in 1.53 s,
  and searched in 47 ms while the renderer remained responsive. Eight PTYs and
  three servers cleaned up, RSS settled from 397 to 422 MiB after restoration,
  median idle CPU was 0%, and no renderer errors were captured.
- Fixed the visible idle terminal consuming about 10.5% CPU through continuous
  cursor repainting. A solid cursor preserves usability while removing the
  animation; three packaged launch cycles settled at 1.4–1.8% total CPU and
  371–376 MiB RSS with the terminal visible.
- Verified three real package launch/quit cycles: cold shell/workspace readiness
  in 10.5/11.2 s after rebuilding, warm readiness in at most 4.0/4.6 s, graceful
  quit in under one second, complete helper-process cleanup, zero renderer
  errors, and no serious stderr diagnostics.
- Re-ran the complete suite after the performance repairs: 237 tests passed,
  one native Keychain test remained intentionally skipped from the normal run,
  TypeScript passed, and zero tests failed across 23 files.

## 2026-09-06

- Repaired cloud-provider status so OmniCode no longer equates a stored API key
  with a working connection. Save and Test Connection now call the providers'
  lightweight models endpoints and report stored/not-tested, connected,
  authentication-failed, unavailable, and not-configured states separately.
- Added regression coverage for the exact OpenAI, Anthropic, and Google
  connection URLs and headers plus missing credentials, invalid credentials,
  rate limits, network failures, and credential redaction.
- Verified the rebuilt packaged Settings/Keychain workflow with a temporary
  OpenAI audit credential: save, automatic authentication failure, persistence
  across a full app restart, actual chat retrieval, redacted error, explicit
  retest, and deletion all passed. The pre-existing Google key was untouched.
- Verified Google Gemini end to end in the packaged app using the already saved
  Keychain credential: the authentication probe connected and the real minimal
  prompt returned the exact expected response with no renderer errors.
- Audited Ollama on the real host and rebuilt package. The CLI and app bundle are
  absent, port 11434 refuses connections, installed-model count is zero, the UI
  accurately says Not Installed, and all model download controls remain disabled.
- Replaced the raw offline Local AI `TypeError: fetch failed` with an actionable
  distinction between Ollama not installed and installed-but-service-unavailable,
  while preserving genuine HTTP/model diagnostics. Added unit and packaged
  regression coverage; real inference remains externally blocked.
- Fixed workspace AI context going stale after file changes by debouncing index
  refreshes from the existing filesystem watcher. Packaged update, create,
  rename, and delete lifecycle tests now return current files without a manual
  reindex.
- Fixed README and manifest ranking so a tie-break bonus cannot make an unrelated
  file appear relevant when no query token matches.
- Verified live multi-file Workspace context in the AI sidebar: consent listed
  the retrieved paths and Gemini derived three undisclosed values from the
  disposable project. Sensitive/ignored files stayed excluded and an outside
  attachment was denied.
- Moved Agent dangerous-command policy and confirmation into the main process,
  expanded blocking for privileged/destructive/Keychain/nested-shell patterns,
  and made the three permission tiers control cloud-context consent rather than
  merely changing a label.
- Added packaged diff/security coverage. Real modify/create/delete changes stayed
  staged until acceptance, acceptance matched disk, undo restored the snapshot,
  rejection preserved disk, traversal/wrong-workspace/`sudo` requests were
  denied, and cleanup completed without renderer errors.
- Exercised the real multi-file Agent planning workflow. Two calls stopped safely
  on Google's transient HTTP 503 high-demand response and wrote nothing; a later
  bounded retry read config/database facts, proposed one derived file, opened
  Diff Review, stayed in-memory until acceptance, matched disk after acceptance,
  and disappeared after undo with zero renderer errors.
- Added strict runtime validation for persisted renderer theme, Agent permission,
  autocomplete provider, and model values so corrupt local storage falls back to
  safe supported states.
- Verified packaged settings persistence across a full app restart for theme,
  autosave, permission tier, autocomplete state/provider/model, then restored the
  isolated profile snapshot.
- Verified workspace settings round-trip and atomic `0600` storage, rejection
  without overwrite, precise malformed-JSON diagnostics, restart behavior, and
  cleanup of the disposable metadata directory.
- Fixed native Undo/Redo so the macOS Edit menu and `⌘Z`/`⌘Shift+Z` operate on
  Monaco's text-model history while normal inputs retain DOM history.
- Fixed Search Replace All clearing its own success notice during result refresh;
  a packaged two-file replacement now reports and matches exact disk changes.
- Added a Sonoma-safe `⌘I` fallback for Inline AI after proving the enabled menu
  item worked but Electron dropped the advertised custom accelerator.
- Raised low-contrast light/dark muted, accent, and warning tokens and verified
  all normal-text ratios at or above 4.5:1 in the rebuilt package.
- Added a packaged editor/shortcut/theme/layout audit covering native macOS
  keystrokes, three tabs, Undo/Redo/Save, Search/Replace All, indentation and
  bracket completion, line/syntax/folding/minimap rendering, Inline AI prompt,
  all themes, focus/disabled states, bounded panel resizing, visibility toggles,
  terminal toggle, cleanup, and zero renderer exceptions.
- Re-ran the complete suite after these repairs: 235 tests passed, one native
  Keychain test remained intentionally skipped from the normal run, and zero
  tests failed across 23 files.
- Added a packaged file-lifecycle audit. Delayed autosave wrote exact bytes,
  clean external writes reloaded, clean deletes closed their tabs, dirty
  conflicts blocked overwrite without losing either version, unsaved-tab
  Cancel/Discard behaved correctly, and a real permission-denied save retained
  both disk data and the dirty buffer. The isolated preference and disposable
  fixture were restored/removed with zero renderer errors.
- Verified the packaged native window lifecycle through macOS accessibility:
  resize, minimize/restore, Zoom/unzoom, full-screen enter/exit, close, renderer
  teardown, Finder-style reopen, and renderer recreation all passed.
- Verified the real native unsaved-changes sheet and all three choices. Cancel
  retained the window, dirty buffer, and disk baseline; Discard Changes closed
  without writing; Save All wrote exact bytes before closing. Reopen, preference
  restoration, fixture cleanup, and renderer-error checks also passed.
- Verified native Save As and Open sheets: Save As wrote exact bytes under a
  space-containing name, preserved the source, updated the tab path, and native
  Open selected that exact file and loaded it into Monaco.
- Fixed Reveal in Finder after the packaged Electron helper opened the folder
  without reliably selecting the item. The authorized path now uses native
  `open -R`; the real Explorer action selected the exact file. Reveal, copy-path,
  default-open, and Open-With rejections now route to visible error handling.
- Verified Explorer Open With through the real native application sheet. The
  selected system TextEdit bundle opened the exact disposable filename/content,
  then the app/document and Finder audit window were restored or closed.
- Opened every native application menu, verified 11 top-level menus and 48
  expected items, and exercised a renderer-bound toggle without changing the
  final layout state.
- Verified terminal history replay, output search/highlight, clear, the native
  new-terminal shortcut, tab switching, split UI, restart, kill, and panel close
  in the rebuilt package with zero renderer errors.
- Verified packaged drag-and-drop for an external Unicode-named file, external
  folder authorization/workspace switch, and Explorer row-to-folder move. Exact
  content and disk movement passed, the original workspace was restored, and
  disposable data was moved to Trash.
- Verified every implemented AI context control in one real packaged Gemini
  request: current file, open files, selected code, terminal output, TypeScript
  problems, Git changes, and a separately native-picked file. Consent listed
  exact categories/paths and nonzero sizes; Gemini returned the exact seven-
  context success marker. New Chat cleared the conversation and the original
  permission/workspace were restored.

## 2026-09-05

- Opened the stabilization phase and inventoried the actual Electron/React/
  TypeScript repository.
- Recorded the no-history Git baseline: `master` with no commits and all project
  files untracked.
- Re-ran a fresh packaged Intel launch on macOS Sonoma. Setup, workbench,
  workspace IPC, real zsh PTY, local static server, secret-path denial, and
  renderer console capture passed.
- Created the permanent status, test matrix, known-issues, and stabilization
  changelog documents before beginning repair work.
- Created baseline checkpoint `7e85887` before implementation repairs.
- Added a repeatable packaged filesystem/editor audit covering real nested and
  Unicode paths, rename/move/duplicate/search/replace/trash, binary and workspace
  boundaries, Monaco editing/dirty/save/find, Settings, tab close, and renderer
  error capture.
- Fixed repeated Monaco inline-completion disposal exceptions during ordinary
  editing by updating the provider to Monaco 0.56's current disposal contract.
- Rebuilt the Intel production app and confirmed the filesystem/editor audit
  completes with zero renderer exceptions.
- Added packaged terminal/runtime auditing for real zsh cwd, identity,
  environment, Homebrew paths, Ctrl+C, multiple sessions, restart, resize,
  workspace isolation, and host-vs-app tool detection.
- Fixed Sonoma hardware parsing so Metal 3 is recognized and attached displays
  are not listed as GPUs; verified against this Mac's real profiler output.
- Added explicit Run-terminal process exit-code reporting with regression tests.
- Added real packaged run/compile coverage: Python, JavaScript, C, C++, Swift,
  and Java passed; deliberate Python, Node, Clang, and missing-TypeScript-runtime
  failures returned nonzero with useful diagnostics.
- Fixed package development servers falsely reporting success immediately after
  npm spawned. Startup now waits for a real reachable localhost port and reports
  premature exit, timeout, and occupied ports accurately.
- Added real packaged static-server and npm-project coverage for HTML/CSS/JS,
  nested assets, live-reload events, port conflicts, restart/release, package
  detection, Run-view scripts, server logs, and process-tree shutdown.
- Fixed porcelain Git status parsing for working-tree rename/copy records and
  added credential/token redaction to Git process errors.
- Added a packaged Git audit covering UI init, diff, stage, unstage, commit,
  create/switch/delete branch, rename metadata, useful failure reporting, and
  real fetch/pull/push synchronization against a local bare remote.
- Verified real clone behavior through the manager and confirmed public HTTPS
  cloning from GitHub; authenticated GitHub/SSH testing remains externally blocked.

## Baseline inherited from OmniCode 0.1.1

These repairs predate this audit but are present in its starting point:

- Fixed macOS Keychain writes that could report success while saving an empty
  cloud credential; added exact readback verification.
- Fixed Keychain delete handling for macOS success output written to stderr.
- Added actual setup downloads/installations, progress, cancellation, refresh,
  Ollama startup, and curated model pulls.
- Fixed native Ollama application discovery and fresh-Mac Apple shim detection.
- Fixed cloud empty/refused/blocked response handling and AI provider/model state
  synchronization.
