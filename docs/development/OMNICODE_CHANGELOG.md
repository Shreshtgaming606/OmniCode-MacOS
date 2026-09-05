# OmniCode Stabilization Changelog

This log records repairs and audit milestones made during the no-new-features
stabilization phase.

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
