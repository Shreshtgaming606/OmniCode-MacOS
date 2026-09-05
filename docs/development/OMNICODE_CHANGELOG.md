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

