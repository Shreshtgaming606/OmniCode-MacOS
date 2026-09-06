# OmniCode Stabilization Changelog

This log records repairs and audit milestones made during the no-new-features
stabilization phase.

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
