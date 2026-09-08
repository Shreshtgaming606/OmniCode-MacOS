# OmniCode Stabilization Changelog

This log records repairs and audit milestones made during the no-new-features
stabilization phase.

## 2026-09-07

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
- Audited runtime-install authorization and failure behavior. Native Cancel on
  installed Git started no process/progress, an invalid tool ID failed before a
  dialog, and a real missing-Go attempt surfaced Homebrew's non-writable-folder
  failure without claiming success or leaving Go/a package process installed.
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
