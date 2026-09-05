# OmniCode Known Issues

Last updated: 2026-09-05

Resolved issues remain in this file with a resolution so audit history is not
lost. Secrets, tokens, and authorization headers must never be included here.

## OMI-001 — Provider status does not verify connectivity

- Severity: High
- Reproduction: Save a syntactically non-empty but invalid API key in Settings.
- Expected: The provider is shown as authenticated only after a minimal provider
  request succeeds; authentication/network/model failures are distinguishable.
- Actual: Settings reports only whether a credential is stored in Keychain.
- Suspected cause: No connection-test API or UI state exists.
- Relevant files: `src/renderer/src/components/SettingsPanel.tsx`,
  `src/main/services/ai-manager.ts`, `src/main/index.ts`, `src/preload/index.ts`,
  `src/shared/contracts.ts`.
- Current status: 🔴 Open — repair scheduled during provider audit.

## OMI-002 — Real cloud-provider operation is unverified

- Severity: High
- Reproduction: Configure a valid OpenAI, Claude, or Gemini key and send a prompt.
- Expected: Minimal request succeeds, UI receives the answer, and credentials do
  not appear in output or logs.
- Actual: Request shapes and failures pass mocked tests; a paid live request has
  not been authorized or executed in this audit.
- Suspected cause: Valid account credentials and account/model access are external.
- Relevant files: `src/main/services/ai-manager.ts`,
  `src/renderer/src/components/AIChat.tsx`, `src/main/services/credential-manager.ts`.
- Current status: 🔵 BLOCKED — USER CONFIGURATION REQUIRED if no usable key is
  configured. Everything around the live call remains testable.

## OMI-003 — Local inference is unverified on the current host

- Severity: High
- Reproduction: Start Ollama, select an installed model, and send the exact test
  prompt through OmniCode.
- Expected: The selected model answers and the UI exits its loading state.
- Actual: API/request/parser code is covered, but no real inference has been
  observed in this audit.
- Suspected cause: Ollama service/model availability is external host state.
- Relevant files: `src/main/services/ai-manager.ts`,
  `src/renderer/src/components/AIChat.tsx`, `src/renderer/src/components/ModelsView.tsx`.
- Current status: 🔵 Pending host inspection; may become BLOCKED — USER
  CONFIGURATION REQUIRED.

## OMI-004 — Authenticated GitHub remote operations are unverified

- Severity: Medium
- Reproduction: Clone, fetch, pull, and push a safe HTTPS and SSH repository.
- Expected: Operations complete only after Git exits successfully and errors are
  displayed without exposing credentials.
- Actual: Generic Git backend/tests exist; no safe authenticated remote was used.
- Suspected cause: Repository and authentication are external requirements.
- Relevant files: `src/main/services/git-manager.ts`,
  `src/renderer/src/components/SourceControlView.tsx`.
- Current status: 🔵 BLOCKED — USER CONFIGURATION REQUIRED for write testing;
  public read-only clone can still be tested.

## OMI-005 — Repository had no baseline commit

- Severity: High
- Reproduction: Run `git log` at stabilization start.
- Expected: A recoverable project history exists before broad repair work.
- Actual: `master` had no commits and every project file was untracked.
- Suspected cause: Initial application work was never committed.
- Relevant files: entire repository.
- Current status: 🟡 Open — create a non-destructive baseline checkpoint before
  implementation repairs.

## OMI-006 — Distribution is unsigned and unnotarized

- Severity: High for public distribution; Low for local testing
- Reproduction: Inspect build identities or distribute the DMG to another Mac.
- Expected: Public release is signed, notarized, and stapled.
- Actual: No valid Developer ID Application identity is installed.
- Suspected cause: Apple developer credentials are an external requirement.
- Relevant files: `package.json` build configuration and release artifacts.
- Current status: 🔵 BLOCKED — APPLE DEVELOPER ID REQUIRED.

## OMI-007 — Critical renderer workflows lack end-to-end coverage

- Severity: High
- Reproduction: Inspect tests; most UI operations are not driven through the
  packaged renderer.
- Expected: Repeatable tests cover open/edit/save, Git, run, diff, settings, and
  the core AI path.
- Actual: Existing packaged smoke covers startup, setup, workspace reads, PTY,
  server security, and cold file open only.
- Suspected cause: Smoke suite grew incrementally around packaging milestones.
- Relevant files: `scripts/`, `src/renderer/src/components/`.
- Current status: 🟡 Open — expand integration/E2E coverage during each audit area.

## OMI-008 — AI chat is non-streaming and cannot stop generation

- Severity: Medium
- Reproduction: Send a long AI request.
- Expected if claimed: Incremental output and a stop control.
- Actual: One request resolves to one final response; no cancellation UI exists.
- Suspected cause: Streaming/cancellation was never implemented.
- Relevant files: `src/main/services/ai-manager.ts`,
  `src/renderer/src/components/AIChat.tsx`, `src/shared/contracts.ts`.
- Current status: ⚪ Not implemented. Do not add during stabilization unless
  existing product copy is found to promise it.

## OMI-009 — Workbench layout does not persist across restart

- Severity: Low
- Reproduction: Resize Explorer, AI sidebar, or bottom panel; restart OmniCode.
- Expected if claimed: Previous dimensions are restored.
- Actual: Dimensions initialize from constants; no stored layout was found.
- Suspected cause: Persistence was never implemented.
- Relevant files: `src/renderer/src/App.tsx`.
- Current status: ⚪ Not implemented. Verify no UI/documentation promise exists.

## OMI-010 — Apple-silicon package cannot be launched on the Intel test Mac

- Severity: Medium
- Reproduction: Attempt to run the arm64 app on the x86_64 Sonoma build host.
- Expected: Architecture-specific app launches on matching Apple hardware.
- Actual: Static architecture and archive checks pass; native execution is not
  possible on this host.
- Suspected cause: External hardware requirement.
- Relevant files: `dist/mac-arm64/OmniCode.app`.
- Current status: 🔵 BLOCKED — APPLE-SILICON HARDWARE REQUIRED.

