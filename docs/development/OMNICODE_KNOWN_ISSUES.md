# OmniCode Known Issues

Last updated: 2026-09-06

Resolved issues remain in this file with a resolution so audit history is not
lost. Secrets, tokens, and authorization headers must never be included here.

## OMI-001 — Provider status did not verify connectivity — Resolved

- Severity: High
- Reproduction: Save a syntactically non-empty but invalid API key in Settings.
- Expected: The provider is shown as authenticated only after a minimal provider
  request succeeds; authentication/network/model failures are distinguishable.
- Actual: Settings previously reported only whether a credential was stored in
  Keychain.
- Suspected cause: No connection-test API or UI state exists.
- Relevant files: `src/renderer/src/components/SettingsPanel.tsx`,
  `src/main/services/ai-manager.ts`, `src/main/index.ts`, `src/preload/index.ts`,
  `src/shared/contracts.ts`.
- Current status: ✅ Resolved — Settings now starts at Stored / Not tested,
  performs a real lightweight provider request on Save or Test Connection, and
  distinguishes Connected, Authentication failed, unavailable, and not
  configured. Unit tests cover all three providers; packaged invalid-OpenAI and
  valid-Gemini workflows passed.

## OMI-002 — Some real cloud-provider operations require credentials

- Severity: High
- Reproduction: Configure a valid OpenAI, Claude, or Gemini key and send a prompt.
- Expected: Minimal request succeeds, UI receives the answer, and credentials do
  not appear in output or logs.
- Actual: Gemini authentication and an exact live response passed through the
  rebuilt packaged app. A temporary invalid OpenAI key was proved to persist,
  be retrieved, and produce a redacted authentication failure. OpenAI success
  and all Claude live behavior remain unavailable because those keys are not
  configured.
- Suspected cause: Valid account credentials and account/model access are external.
- Relevant files: `src/main/services/ai-manager.ts`,
  `src/renderer/src/components/AIChat.tsx`, `src/main/services/credential-manager.ts`.
- Current status: 🟡 Partially resolved — Gemini is verified end to end. OpenAI
  and Claude successful live requests are BLOCKED — USER CONFIGURATION REQUIRED.
  Gemini also completed the live multi-file Chat context test. Two Agent planning
  attempts received an honest transient HTTP 503 high-demand response; a bounded
  later retry succeeded through propose/review/accept/undo. No user credential
  was overwritten or printed.

## OMI-003 — Local inference is unverified on the current host

- Severity: High
- Reproduction: Start Ollama, select an installed model, and send the exact test
  prompt through OmniCode.
- Expected: The selected model answers and the UI exits its loading state.
- Actual: API/request/parser code is covered. Current-host CLI and app-bundle
  checks are absent, port 11434 refuses connections, and the rebuilt app
  correctly reports Not Installed; no real inference can therefore run.
- Suspected cause: Ollama service/model availability is external host state.
- Relevant files: `src/main/services/ai-manager.ts`,
  `src/renderer/src/components/AIChat.tsx`, `src/renderer/src/components/ModelsView.tsx`.
- Current status: 🔵 BLOCKED — OLLAMA INSTALLATION AND AN INSTALLED MODEL
  REQUIRED. Absence detection, disabled model actions, failed-chat behavior,
  and actionable diagnostics are verified in the rebuilt package.

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

## OMI-017 — Offline Ollama chat exposed a low-level fetch error — Resolved

- Severity: Medium
- Reproduction: Select Local AI and send a prompt when Ollama is absent or its
  service is stopped.
- Expected: OmniCode identifies whether installation or service startup is
  needed and does not claim the prompt succeeded.
- Actual: The packaged app previously surfaced `TypeError: fetch failed`.
- Suspected cause: The Ollama chat adapter passed Node's raw transport failure
  through IPC without mapping it to the detected local-service state.
- Relevant files: `src/main/services/ai-manager.ts`,
  `src/main/services/ai-manager.test.ts`, `scripts/audit-ollama.mjs`.
- Current status: ✅ Resolved — the adapter now reports either Not Installed or
  Installed but Service Unavailable, while preserving real Ollama HTTP/model
  diagnostics. The rebuilt packaged absence workflow passed with no renderer
  exceptions.

## OMI-018 — Workspace AI index became stale after file changes — Resolved

- Severity: High
- Reproduction: Open/index a workspace, then update, create, rename, or delete a
  file and request matching workspace context without manually reindexing.
- Expected: Retrieval reflects the current filesystem.
- Actual: The watcher refreshed Explorer only; AI context retained the opening
  snapshot until the user explicitly ran Index Workspace.
- Suspected cause: No index refresh was scheduled from `workspace:changed`.
- Relevant files: `src/renderer/src/App.tsx`,
  `src/main/services/workspace-indexer.ts`, `scripts/audit-ai-context.mjs`.
- Current status: ✅ Resolved — watcher events now debounce a bounded reindex;
  packaged update/create/rename/delete tests all returned current paths/content.

## OMI-019 — README matched unrelated context queries — Resolved

- Severity: Medium
- Reproduction: Query a freshly indexed workspace for a unique token absent from
  every file while a README or supported manifest exists.
- Expected: No context file is returned.
- Actual: README/manifests received an unconditional ranking bonus and therefore
  passed the positive-score filter without a token match.
- Suspected cause: The metadata tie-break bonus ran before checking base score.
- Relevant files: `src/main/services/workspace-indexer.ts`,
  `src/main/services/workspace-indexer.test.ts`.
- Current status: ✅ Resolved — the bonus now applies only to files with a real
  query match; unit and rebuilt packaged tests pass.

## OMI-020 — Agent command safety lived only in React — Resolved

- Severity: Critical
- Reproduction: Inspect the Agent command path; the renderer filtered text and
  used `window.confirm`, then forwarded the command to a normal terminal.
- Expected: Agent-specific command policy and approval have a main-process
  enforcement point independent of the WebView handler.
- Actual: No Agent command IPC boundary existed.
- Suspected cause: Agent execution reused the terminal flow without a privileged
  approval service.
- Relevant files: `src/main/services/agent-command-policy.ts`,
  `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`.
- Current status: ✅ Resolved — command validation and native confirmation now
  run in the main process. Packaged calls blocked `sudo` and wrong-workspace
  requests; unit coverage blocks destructive, privileged, Keychain-read,
  download-pipe, global-install, and nested-shell patterns.

## OMI-021 — Corrupt renderer preferences were trusted as valid — Resolved

- Severity: Medium
- Reproduction: Put an unsupported string in the theme, Agent permission,
  autocomplete provider, or model local-storage entry and restart OmniCode.
- Expected: OmniCode falls back to a safe supported value.
- Actual: Theme and permission strings were cast to TypeScript unions without
  runtime validation; malformed model values were also accepted.
- Suspected cause: Preference initialization relied on compile-time assertions
  for persistent external data.
- Relevant files: `src/renderer/src/lib/preferences.ts`,
  `src/renderer/src/lib/preferences.test.ts`, `src/renderer/src/App.tsx`.
- Current status: ✅ Resolved — stored enums and model names are validated and
  safely defaulted. Unit tests cover invalid/multiline/oversized data; valid UI
  preferences passed a full packaged restart.

## OMI-022 — Replace All success notice disappeared — Resolved

- Severity: Low
- Reproduction: Run a successful multi-file Replace All from the Search sidebar.
- Expected: The UI reports the replacement/file count after results refresh.
- Actual: Both files changed, but `search()` immediately cleared the notice.
- Suspected cause: The notice was set before awaiting the refresh routine.
- Relevant files: `src/renderer/src/components/SearchView.tsx`,
  `scripts/audit-editor-shortcuts-layout.mjs`.
- Current status: ✅ Resolved — the notice is set after refresh; packaged UI and
  exact disk contents passed.

## OMI-023 — Native Undo/Redo did not target Monaco history — Resolved

- Severity: High
- Reproduction: Edit a Monaco document and press `⌘Z` or `⌘Shift+Z`.
- Expected: The document model, dirty state, and subsequent Save reflect the
  undo/redo operation.
- Actual: Electron's generic DOM undo role did not operate on Monaco's model.
- Suspected cause: Monaco 0.56 owns a separate text-model history and its native
  edit context resembles an ordinary page editor.
- Relevant files: `src/main/menu.ts`, `src/renderer/src/App.tsx`,
  `scripts/audit-editor-shortcuts-layout.mjs`.
- Current status: ✅ Resolved — native menu commands route Monaco focus to the
  text model's `undo()`/`redo()` and retain DOM undo for normal text fields;
  packaged native-key and exact-disk tests passed.

## OMI-024 — Advertised Inline AI shortcut was dropped on Sonoma — Resolved

- Severity: Medium
- Reproduction: Select code and press `⌘I` in the packaged app.
- Expected: The Inline AI prompt opens with the selection.
- Actual: Clicking the enabled AI menu item worked, but the custom accelerator
  did not consistently dispatch from macOS to Electron.
- Suspected cause: Native custom accelerator routing conflict on the tested
  Sonoma/WebView combination.
- Relevant files: `src/renderer/src/App.tsx`, `src/main/menu.ts`,
  `scripts/audit-editor-shortcuts-layout.mjs`.
- Current status: ✅ Resolved — a capture-phase renderer fallback handles the
  exact unmodified `⌘I` chord; the packaged native keystroke opened the prompt.

## OMI-025 — Theme secondary colors failed normal-text contrast — Resolved

- Severity: Medium
- Reproduction: Measure muted/accent/warning tokens on sidebar backgrounds.
- Expected: Normal text reaches at least WCAG AA 4.5:1 contrast.
- Actual: Muted text measured 3.15:1 light and 3.61:1 dark; light accent and
  warning also fell below 4.5:1.
- Suspected cause: Tokens were chosen visually without ratio validation.
- Relevant files: `src/renderer/src/styles.css`,
  `scripts/audit-editor-shortcuts-layout.mjs`.
- Current status: ✅ Resolved — packaged computed styles measure light
  4.72/4.51/4.70 and dark 5.42/5.08/7.17 for muted/accent/warning.

## OMI-026 — Reveal in Finder did not select the requested item — Resolved

- Severity: Medium
- Reproduction: Use the Explorer's Reveal in Finder action for a nested file on
  the tested Sonoma host.
- Expected: Finder opens the containing folder and selects the exact file.
- Actual: Electron's helper opened the folder but did not reliably retain the
  requested selection.
- Suspected cause: Platform-specific `shell.showItemInFolder` behavior in the
  packaged Electron runtime.
- Relevant files: `src/main/services/filesystem-manager.ts`,
  `src/renderer/src/App.tsx`, `scripts/audit-finder-integration.mjs`.
- Current status: ✅ Resolved — the authorized path is passed to macOS
  `/usr/bin/open -R`; the packaged Explorer action selected the exact canonical
  path. Related context-action rejections now reach visible error reporting.
