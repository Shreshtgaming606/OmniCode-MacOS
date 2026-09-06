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

## OMI-005 — Repository had no baseline commit — Resolved

- Severity: High
- Reproduction: Run `git log` at stabilization start.
- Expected: A recoverable project history exists before broad repair work.
- Actual: `master` had no commits and every project file was untracked.
- Suspected cause: Initial application work was never committed.
- Relevant files: entire repository.
- Current status: ✅ Resolved — checkpoint `7e85887` preserves the complete
  pre-repair baseline.

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

## OMI-011 — Monaco inline-completion disposal errors — Resolved

- Severity: High
- Reproduction: Open a file in the packaged app and make ordinary editor changes;
  capture `Runtime.exceptionThrown` events.
- Expected: Editing with autocomplete disabled produces no inline-completion
  errors.
- Actual: Monaco repeatedly threw `this.provider.disposeInlineCompletions is not
  a function` because OmniCode implemented an obsolete disposal method name.
- Suspected cause: The provider contract changed in Monaco 0.56 while the
  registration object remained on the older API.
- Relevant files: `src/renderer/src/App.tsx`,
  `scripts/audit-files-editor.mjs`.
- Current status: ✅ Resolved — implemented and type-checked the current
  `disposeInlineCompletions` contract; the rebuilt packaged workflow completes
  with no renderer errors.

## OMI-012 — Sonoma Metal hardware profile was parsed incorrectly — Resolved

- Severity: Medium
- Reproduction: Open hardware/setup data on the current Intel Sonoma Mac.
- Expected: Intel UHD Graphics 617 is the only GPU and Metal 3 is supported.
- Actual: OmniCode reported Metal unsupported and included `Color LCD` as a GPU.
- Suspected cause: The parser did not recognize Sonoma's
  `spdisplays_mtlgpufamilysupport` key/token and recursively treated nested
  display records as graphics devices.
- Relevant files: `src/main/services/hardware-manager.ts`,
  `src/main/services/hardware-manager.test.ts`.
- Current status: ✅ Resolved — the parser recognizes Metal-family tokens and
  filters display records; verified in the rebuilt packaged app on the real host.

## OMI-013 — Run sessions did not report process exit codes — Resolved

- Severity: High
- Reproduction: Run a successful or failing file from the Run button.
- Expected: stdout/stderr and the real exit code are visible.
- Actual: The command ran in an interactive terminal and returned to the prompt,
  but no explicit exit code was displayed.
- Suspected cause: The generated terminal command did not capture `$?`.
- Relevant files: `src/renderer/src/lib/terminal-command.ts`,
  `src/renderer/src/components/TerminalPanel.tsx`.
- Current status: ✅ Resolved — Run commands now print
  `[Process exited with code N]`; unit tests cover success/failure and packaged UI
  execution confirmed code 0.

## OMI-014 — Package development servers reported success before readiness — Resolved

- Severity: High
- Reproduction: Configure an npm `dev` script that immediately exits with code
  7, then start it from OmniCode.
- Expected: Startup fails with the real exit reason and the UI remains stopped.
- Actual: OmniCode returned `running: true` as soon as npm spawned, even though
  the child exited and no localhost endpoint existed.
- Suspected cause: `startProject` waited only for the child-process `spawn` event.
- Relevant files: `src/main/services/dev-server-manager.ts`,
  `src/main/services/dev-server-manager.test.ts`,
  `scripts/audit-server-npm.mjs`.
- Current status: ✅ Resolved — startup now requires a detected, reachable local
  port; premature exit, timeout, and explicit port conflict are failures. Real
  failing and successful npm fixtures passed in the rebuilt packaged app.

## OMI-015 — Working-tree rename records could corrupt Git status parsing — Resolved

- Severity: High
- Reproduction: Parse porcelain-v1 `-z` output where the working-tree status,
  rather than the index status, is `R` or `C`.
- Expected: The destination is one change and the following NUL record is its
  original path.
- Actual: Only index-side `R`/`C` consumed the original-path record, so a
  worktree rename/copy could create a bogus second change.
- Suspected cause: The parser inspected only the first status column.
- Relevant files: `src/main/services/git-manager.ts`,
  `src/main/services/git-manager.test.ts`, `scripts/audit-git.mjs`.
- Current status: ✅ Resolved — both status columns consume rename/copy metadata;
  regression tests pass and a real staged rename was verified in the package.

## OMI-016 — Git failures could expose credentials embedded in URLs — Resolved

- Severity: High
- Reproduction: A Git remote with a URL password/token fails and Git repeats the
  URL in stderr.
- Expected: The useful error is shown without credential material.
- Actual: `runGit` previously returned raw stderr in its thrown error.
- Suspected cause: No Git-specific secret scrubber was applied at the process
  boundary.
- Relevant files: `src/main/services/git-manager.ts`,
  `src/main/services/git-manager.test.ts`.
- Current status: ✅ Resolved — URL passwords, token-only HTTPS credentials,
  sensitive query parameters, and recognizable GitHub token forms are redacted;
  regression coverage confirms the original values are absent.
