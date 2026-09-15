# OmniCode Known Issues

Last updated: 2026-09-14

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
- Current status: 🟡 Partially resolved — Gemini is verified end to end in both
  Code and Work modes, including real 3.7 streaming and a real Managed Browser
  tool turn. OpenAI
  and Claude successful live requests are BLOCKED — USER CONFIGURATION REQUIRED.
  Gemini also completed the live multi-file Chat context test. Two Agent planning
  attempts received an honest transient HTTP 503 high-demand response; a bounded
  later retry succeeded through propose/review/accept/undo. A subsequent bounded
  command-only Agent audit encountered repeated real `fetch failed` transport
  errors; it stopped without a proposal, command, or filesystem write and
  restored its temporary harness state. Retrying against Google's current
  Flash-Lite replacement then completed the command-only plan, native approval,
  workspace PTY execution, and cleanup after three additional transient
  failures. No user credential was overwritten or printed.

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
  pre-repair baseline and `28bb077` preserves the stabilized 0.1.1 state before
  the `codex/work-mode` expansion.

## OMI-006 — Distribution is unsigned and unnotarized

- Severity: High for public distribution; Low for local testing
- Reproduction: Inspect build identities or distribute the DMG to another Mac.
- Expected: Public release is signed, notarized, and stapled.
- Actual: Final Intel and Apple Silicon 0.3.0 installers build and pass archive
  validation, but no valid Developer ID Application identity is installed, so
  they are unsigned and unnotarized.
- Suspected cause: Apple developer credentials are an external requirement.
- Relevant files: `package.json` build configuration and release artifacts.
- Current status: 🔵 BLOCKED — APPLE DEVELOPER ID REQUIRED.
  This also blocks native Notification Center delivery: the packaged notification
  IPC accepts valid bounded content and rejects invalid content, but Electron's
  macOS notification contract states unsigned development builds are not
  delivered. The current-host banner audit therefore observed no notification.

## OMI-007 — Critical renderer workflows lack end-to-end coverage — Resolved

- Severity: High
- Reproduction: Inspect tests; most UI operations are not driven through the
  packaged renderer.
- Expected: Repeatable tests cover open/edit/save, Git, run, diff, settings, and
  the core AI path.
- Actual: Existing packaged smoke covers startup, setup, workspace reads, PTY,
  server security, and cold file open only.
- Suspected cause: Smoke suite grew incrementally around packaging milestones.
- Relevant files: `scripts/`, `src/renderer/src/components/`.
- Current status: ✅ Resolved — repeatable packaged audits now cover startup,
  native window/dialog/clipboard behavior, open/edit/save/Save As, Explorer
  lifecycle and drag/drop, terminal/Run, local server plus real-browser reload,
  Git, Keychain/provider state, live Gemini Chat/Markdown/context, Agent,
  separate Work Mode, conversation persistence, streaming, Connected Apps,
  Managed Browser, model selectors, attachments, and repository import/clone,
  proposal/native command approval, diff/undo, settings/themes, indexing, and
  performance. External credentials, services, and hardware remain explicitly
  blocked rather than falsely passed.

## OMI-008 — Code Chat is non-streaming and cannot stop generation

- Severity: Medium
- Reproduction: Send a long AI request.
- Expected if claimed: Incremental output and a stop control.
- Actual: Code Chat still resolves one final response and has no cancellation
  control. Work Mode now streams OpenAI/Anthropic/Gemini/Ollama responses and
  has a real sender-bound Stop action that preserves cancelled partial output.
- Suspected cause: The original Code Chat transport predates the Work transport;
  changing its interaction model was outside the Work Mode compatibility scope.
- Relevant files: `src/main/services/ai-manager.ts`,
  `src/renderer/src/components/AIChat.tsx`, `src/shared/contracts.ts`.
- Current status: 🟡 Partially resolved — verified in Work Mode, accurately not
  implemented in Code Chat. The Code UI does not claim streaming or Stop.

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
- Actual: The final 0.3.0 arm64 app executable and active `node-pty` module are arm64,
  its ZIP decompresses cleanly, and its DMG mounts with a valid internal
  checksum; native execution is not possible on this Intel host.
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

## OMI-027 — Accelerated search could re-include ignored files — Resolved

- Severity: High
- Reproduction: Search a non-Git workspace with `include: **/*.ts` while it
  contains `.gitignore`, `node_modules`, `.omnicodeignore`, and an explicit
  exclude glob.
- Expected: Positive includes narrow candidate types without overriding default
  or user ignore rules.
- Actual: ripgrep returned files from `node_modules` and `.gitignore` paths.
- Suspected cause: The positive glob was appended after negative globs (ripgrep's
  last matching glob wins), and ripgrep required a Git repository before honoring
  `.gitignore`.
- Relevant files: `src/main/services/filesystem-manager.ts`,
  `src/main/services/filesystem-manager.test.ts`,
  `scripts/audit-performance-soak.mjs`.
- Current status: ✅ Resolved — `--no-require-git` is used and all negative
  globs are applied after the positive include. Unit coverage and the 1,203-file
  packaged soak returned exactly the one permitted match.

## OMI-028 — Concurrent workspace indexing returned stale status — Resolved

- Severity: High
- Reproduction: Open a large workspace (which starts automatic indexing) and
  immediately run Index Workspace manually.
- Expected: Both callers observe the completed index for that workspace.
- Actual: The second request canceled the first, and one caller returned the
  previous workspace's seven-file status while the new index continued.
- Suspected cause: Generation cancellation returned the indexer's current status
  instead of sharing an in-flight same-root operation.
- Relevant files: `src/main/services/workspace-indexer.ts`,
  `src/main/services/workspace-indexer.test.ts`,
  `scripts/audit-performance-soak.mjs`.
- Current status: ✅ Resolved — concurrent requests for the same canonical root
  coalesce onto one indexing promise. Regression tests pass and the rebuilt app
  reports all 1,203 allowed files.

## OMI-029 — Visible idle terminal caused continuous renderer/GPU load — Resolved

- Severity: Medium
- Reproduction: Launch OmniCode with its default visible Terminal panel, wait
  for startup, and compare cumulative renderer/GPU CPU time before and after
  hiding the panel.
- Expected: An idle workbench consumes little sustained CPU.
- Actual: xterm's blinking cursor kept repainting; renderer plus GPU used about
  10.5–10.6% of one CPU core. Hiding the panel reduced the same measurement to
  about 0.2%.
- Suspected cause: `cursorBlink: true` scheduled continuous xterm/GPU repainting
  even when no terminal output or input occurred.
- Relevant files: `src/renderer/src/components/TerminalPanel.tsx`,
  `scripts/audit-startup-soak.mjs`.
- Current status: ✅ Resolved — the terminal retains a visible solid cursor
  without continuous animation. Three packaged launches settled at 1.4–1.8%
  total app CPU with the panel visible, 371–376 MiB RSS, zero renderer errors,
  and full helper-process cleanup after quit.

## OMI-030 — Assistant messages did not render Markdown — Resolved

- Severity: Medium
- Reproduction: Ask any AI provider for a heading, list, or fenced code block.
- Expected: Common Markdown is readable and code fences render as code without
  allowing provider-returned HTML to execute.
- Actual: Assistant content was displayed as one plain preformatted text block.
- Suspected cause: AI Chat intentionally rendered every message through `<pre>`
  and had no safe Markdown presentation component.
- Relevant files: `src/renderer/src/components/AIChat.tsx`,
  `src/renderer/src/components/MarkdownMessage.tsx`,
  `src/renderer/src/components/MarkdownMessage.test.ts`,
  `scripts/audit-ai-markdown.mjs`.
- Current status: ✅ Resolved — assistant replies render Markdown with raw HTML
  left inert and HTTPS-only external-link handling. Two renderer tests pass and
  a real Gemini response in the rebuilt `.app` produced the expected heading,
  list, inline code, and language-tagged JavaScript block with no runtime error.

## OMI-031 — Failures lacked a persistent diagnostic trail — Resolved

- Severity: Medium
- Reproduction: Trigger a backend IPC failure, close the transient UI error,
  then inspect application support data for a bounded diagnostic record.
- Expected: A timestamped subsystem, operation, and error category are retained
  without recording secrets, request bodies, IPC arguments, stacks, or files.
- Actual: Before this repair, failures were visible in the UI but no centralized
  persistent diagnostic log existed.
- Suspected cause: Each subsystem returned errors independently and the trusted
  IPC registration helper did not observe rejected operations.
- Relevant files: `src/main/services/diagnostic-logger.ts`,
  `src/main/index.ts`, `scripts/audit-diagnostic-logging.mjs`.
- Current status: ✅ Resolved — logs are serialized JSON lines, mode `0600`,
  rotated at 512 KiB, and redact common provider keys, GitHub tokens,
  authorization values, URL credentials, and query tokens. Five unit tests and
  a rebuilt packaged boundary-failure audit passed; the real IPC argument was
  absent and the UI still received the accurate denial.

## OMI-032 — Text-entry actions used unsupported Electron prompts — Resolved

- Severity: High
- Reproduction: Click Clone Repository, New Project, Create/Delete Branch, or
  Rename Terminal in the packaged Electron 44 application.
- Expected: A text-entry dialog opens and the requested real operation can
  continue or be canceled.
- Actual: `window.prompt()` throws `Error: prompt() is not supported`; several
  handlers rejected before reaching their backend and appeared to do nothing.
- Suspected cause: Browser prompt behavior was assumed to exist in Electron.
- Relevant files: `src/renderer/src/App.tsx`,
  `src/renderer/src/components/SourceControlView.tsx`,
  `src/renderer/src/components/TerminalPanel.tsx`,
  `scripts/audit-input-dialog-workflows.mjs`.
- Current status: ✅ Resolved — every `window.prompt()` call was replaced with
  OmniCode's styled input modal, including dialog semantics, autofocus,
  disabled-empty confirmation, Cancel, Escape, and backdrop cancellation. A
  rebuilt packaged audit passed real clone/native destination, branch
  create/delete, terminal rename, and Unicode New Project operations with zero
  renderer errors. Native `window.confirm()` support was separately observed.

## OMI-033 — Early native commands could be dropped before subscription — Resolved

- Severity: Medium
- Reproduction: Send a native menu or Finder open command after the first
  renderer paint but before React's command effect subscribes.
- Expected: The requested action runs once the workbench command handler is
  ready.
- Actual: The preload did not attach `ipcRenderer.on('app:command')` until React
  subscribed, so a command in that narrow startup interval disappeared.
- Suspected cause: Native-command receipt and renderer subscription were the
  same operation instead of a relay with startup buffering.
- Relevant files: `src/preload/command-relay.ts`, `src/preload/index.ts`,
  `src/preload/command-relay.test.ts`.
- Current status: ✅ Resolved — preload receipt is immediate and a bounded
  50-command queue drains in order on subscription. Regression tests cover
  queued payloads/order, subsequent live delivery/unsubscribe, and oldest-entry
  eviction at the configured bound; the production preload rebuilt cleanly.

## OMI-034 — Run output was mislabeled as a Debug Console — Resolved

- Severity: Low
- Reproduction: Open the bottom `Debug` tab or read the feature list while no
  debugger adapter exists.
- Expected: The label describes captured task output without claiming native
  debugging.
- Actual: The panel mirrored terminal task output but was named `Debug`/`Debug
  Console`, which could imply breakpoints or a debug-adapter protocol.
- Suspected cause: The output-capture panel retained an aspirational label.
- Relevant files: `src/renderer/src/App.tsx`, `README.md`,
  `scripts/audit-run-custom-config.mjs`.
- Current status: ✅ Resolved — it is now `Run Log`; a rebuilt packaged custom
  task populated it with exact real pre/build/run/post output and exit code.

## OMI-035 — Connected Apps exposed no real Google service implementation — Resolved

- Severity: High
- Reproduction: Attempt to connect Gmail or Google Drive in the original Work
  Mode Connected Apps surface.
- Expected: OmniCode starts Authorization Code + PKCE, stores refresh material
  in Keychain, verifies the selected account, and exposes only real scoped tools.
- Actual: The original surface had only the real read-only Managed Browser;
  Gmail and Drive were not registered and never simulated a connection.
- Suspected cause: The service adapters and shared Google account boundary had
  not yet been implemented.
- Relevant files: `src/main/services/google-oauth-manager.ts`,
  `src/main/connectors/gmail-connector.ts`,
  `src/main/connectors/google-drive-connector.ts`,
  `src/main/services/connector-manager.ts`.
- Current status: ✅ Resolved — Google now has a system-browser loopback flow,
  PKCE/state validation, Keychain persistence, identity/refresh/revoke handling,
  and real Gmail/Drive REST tools. Live account verification remains separately
  and honestly blocked in OMI-039. Unimplemented Microsoft/Discord services are
  not shown as connected or claimed as part of this Google repair.

## OMI-036 — Rich Work attachment extraction is not implemented

- Severity: Medium
- Reproduction: Attach a PDF, Word document, spreadsheet, or image in Work Mode.
- Expected if claimed: A dedicated bounded parser extracts useful content and
  identifies the format accurately.
- Actual: OmniCode supports bounded text/source attachments and rejects binary
  or unsupported inputs explicitly. It does not decode these rich formats or
  pretend their binary bytes are text.
- Suspected cause: Dedicated format parsers and image/vision transport have not
  been integrated.
- Relevant files: `src/main/services/work-attachment-manager.ts`,
  `src/renderer/src/components/work/WorkMode.tsx`.
- Current status: ⚪ Not implemented. Text/source attachment import, privacy,
  persistence, limits, live provider context, and cleanup are verified.

## OMI-037 — Provider tool turns were not interoperable — Resolved

- Severity: High
- Reproduction: Ask Gemini or Ollama in Work Mode to use a registered browser
  tool.
- Expected: The model proposes a structured call, OmniCode executes only the
  registered tool, preserves provider turn metadata, and receives a final answer.
- Actual: Google's API rejected an unsupported JSON-schema keyword and later
  turns could lose thought signatures; the initial Ollama tool-result payload
  did not match Ollama's chat wire format.
- Suspected cause: Provider-specific tool protocols were normalized too early.
- Relevant files: `src/main/services/ai-manager.ts`,
  `src/main/services/ai-tool-types.ts`,
  `src/main/services/work-agent-manager.ts`.
- Current status: ✅ Resolved — provider-native serializers/parsers preserve
  Gemini thought signatures and call IDs, emit supported schemas, and use the
  correct Ollama messages. Unit tests pass and a real Gemini 3.7 browser tool
  turn completed successfully.

## OMI-038 — Unknown local models could receive connected-app tools — Resolved

- Severity: High
- Reproduction: Connect an app, select an installed Ollama model whose tool
  capability is absent or false, and send a Work prompt.
- Expected: The model remains chat-only and receives no tool schemas.
- Actual: The initial handler exposed every connected tool without considering
  the selected local model's inspected metadata.
- Suspected cause: Connector availability and model capability were evaluated
  independently.
- Relevant files: `src/main/index.ts`,
  `src/main/services/work-agent-manager.ts`,
  `src/renderer/src/components/work/WorkModeShell.tsx`.
- Current status: ✅ Resolved — the main process exposes tools to Ollama only
  when the exact installed model explicitly has `toolUse: true`; the UI shows an
  honest chat-only notice and focused regression tests cover the boundary.

## OMI-039 — Google Workspace live authorization was externally blocked — Resolved

- Severity: High for Gmail/Drive release readiness
- Reproduction: Open Connected Apps in the developer-client build, connect Gmail
  or Google Drive, and complete consent with an account that has not been added
  to the Google Cloud OAuth test-user list.
- Expected: A registered OmniCode desktop OAuth client opens Google consent in
  the system browser; after consent the account is verified and service tools
  can perform real API operations.
- Actual: The first attempt correctly reached Google's `403 access_denied` page.
  After the account was added as an approved tester, the packaged 0.3.1 app
  completed consent, verified the identity, connected both Gmail and Drive,
  retained the Keychain grant across restart, and completed minimal read-only
  calls to both APIs.
- Suspected cause: The Google Cloud project was in Testing mode and initially
  lacked the selected account in its explicit test-user list.
- Relevant files: `src/main/services/google-oauth-manager.ts`,
  `src/main/services/secure-keychain-store.ts`,
  `src/main/connectors/gmail-connector.ts`,
  `src/main/connectors/google-drive-connector.ts`,
  `electron.vite.config.ts`, `src/build/google-oauth-build-config.ts`,
  `src/main/index.ts`.
- Current status: ✅ Resolved — the account was approved, real consent and API
  access passed, and no token/account data entered logs or renderer storage.
  Full write/mutation checks remain deliberately unrun without disposable data
  and exact per-action confirmation; that does not invalidate the resolved OAuth
  connection defect.

## OMI-040 — Connector success activity lacked useful result cards — Resolved

- Severity: Medium
- Reproduction: Let a Work tool complete a Gmail search or Drive file listing.
- Expected: The conversation shows a readable provider-specific summary while
  internal service identifiers and binary-transfer capabilities remain private.
- Actual: The activity row showed only a generic completion message even though
  the trusted tool result contained useful bounded metadata.
- Suspected cause: Tool activity had no safe display projection contract.
- Relevant files: `src/shared/work-contracts.ts`,
  `src/main/services/work-agent-manager.ts`,
  `src/main/services/work-conversation-manager.ts`,
  `src/renderer/src/components/work/WorkModeShell.tsx`.
- Current status: ✅ Resolved — trusted Gmail/Drive/file previews are bounded,
  validated, persisted, and rendered as distinct cards. Unit, renderer, dark,
  and compact-light packaged tests verified card reload and absence of internal
  IDs, URLs, transfer IDs, raw bodies, bytes, and local paths.

## OMI-041 — Finder-launched builds could lose Google OAuth configuration — Resolved

- Severity: High for deployed Google connections
- Reproduction: Package OmniCode with an OAuth client available only in the
  publisher shell, then launch the app normally from Finder.
- Expected: The trusted main process can initialize the publisher's desktop
  OAuth client without relying on Finder to inherit a terminal environment.
- Actual: The first implementation read only runtime environment variables, so
  an otherwise correctly prepared production app could appear unconfigured.
- Suspected cause: Deployment configuration was treated as development runtime
  configuration.
- Relevant files: `electron.vite.config.ts`,
  `src/main/services/google-oauth-manager.ts`,
  `src/main/services/google-oauth-manager.test.ts`.
- Current status: ✅ Resolved — an ignored Desktop JSON is validated at build
  time; its matching public-client metadata and Testing marker enter only the
  trusted main bundle while the raw JSON/path remain absent from compiled output
  and tracked source. The Desktop secret is assumed extractable and is not a
  security boundary. Runtime overrides cannot mix client identities; normal
  users receive no publisher configuration UI.

## OMI-042 — Fresh-profile startup soak misclassified onboarding as a timeout — Resolved

- Severity: Medium for release evidence
- Reproduction: Run the reusable three-launch packaged soak against a genuinely
  empty profile.
- Expected: The first cycle recognizes and completes onboarding before measuring
  workbench readiness; later cycles verify warm startup.
- Actual: The harness initially waited only for the workbench and could time out
  even when the app had launched correctly into first-run setup.
- Suspected cause: The soak assumed prior onboarding state.
- Relevant files: `scripts/audit-startup-soak.mjs`.
- Current status: ✅ Resolved — the first cycle now validates the actual setup
  surface, advances safely, and records separate cold shell/workspace timing.
  All three 0.3.0 x64 cycles completed with zero renderer/fatal errors and full
  child-process cleanup.

## OMI-043 — Google authorization failures disappeared after refresh — Resolved

- Severity: High for diagnosability and honest connection state
- Reproduction: Start a Google connection, then cancel it, use an unauthorized
  test account, submit an invalid callback, or allow the callback to time out.
- Expected: Gmail and Drive retain the sanitized failure so the user can see why
  the shared account did not connect.
- Actual: Connector Manager first recorded the real failure, but the subsequent
  shared-service verification found no Keychain token and replaced both cards
  with the generic Connect a Google account state.
- Suspected cause: Transient authorization failure state lived only on the
  individual connector entry while the shared OAuth manager remained unaware of
  it.
- Relevant files: `src/main/services/google-oauth-manager.ts`,
  `src/main/services/google-oauth-manager.test.ts`, `src/main/index.ts`.
- Current status: ✅ Resolved — the shared manager retains a bounded, sanitized
  failure across Gmail and Drive verification until a successful retry or
  disconnect. Regression assertions cover missing publisher configuration,
  Testing-mode access denial, and timeout retention.

## OMI-044 — Approved Google Desktop consent failed at token exchange — Resolved

- Severity: High for Google Workspace connectivity
- Reproduction: Complete approved Google consent with the registered Desktop
  client while sending only the client ID and PKCE verifier to the token endpoint.
- Expected: The authorization code exchanges for a token and the verified shared
  account connects Gmail and Drive.
- Actual: Google redirected successfully, but this registered client returned a
  sanitized `invalid_request` from its token endpoint.
- Suspected cause: Although installed applications cannot keep a confidential
  secret and PKCE remains the meaningful code protection, this Desktop client
  registration expects its matching extractable `client_secret` metadata on
  token exchange and refresh.
- Relevant files: `src/build/google-oauth-build-config.ts`,
  `electron.vite.config.ts`, `src/main/services/google-oauth-manager.ts`,
  `src/main/services/google-oauth-manager.test.ts`.
- Current status: ✅ Resolved — the build loader passes matching Desktop client
  metadata only to the trusted main bundle, the OAuth manager supplies it to
  exchange/refresh requests, renderer/source/leak audits pass, and a subsequent
  real packaged authorization plus restart completed successfully.

## OMI-045 — Work actions used a static, over-prompting permission policy — Resolved

- Severity: High for safety and usability
- Reproduction: Ask Work Mode to complete a multi-step Gmail/Drive task or
  inspect the prior `PermissionManager` and connector settings.
- Expected: Users can choose a safe global/per-app approval mode; routine actions
  do not produce unnecessary prompts; consequential actions and hard boundaries
  are enforced in the backend for both cloud and local models.
- Actual: The prior policy used connector access level plus coarse read/write/
  destructive/sensitive classes. It had no global mode, per-connector override,
  risk/reversibility metadata, Full warning, durable safe activity, or in-Work
  approval surface; normal writes could repeatedly prompt and the UI could not
  explain the evaluated policy.
- Suspected cause: The original permission layer was a secure minimum for the
  first connector implementation, not the complete user-configurable approval
  model required by Work Mode.
- Relevant files: `src/main/services/permission-manager.ts`,
  `src/main/services/work-permission-settings-manager.ts`,
  `src/main/services/work-action-history-manager.ts`, `src/main/index.ts`,
  `src/shared/tool-contracts.ts`, `src/renderer/src/components/work/`,
  `src/renderer/src/components/SettingsPanel.tsx`.
- Current status: ✅ Resolved — Ask, Approve for me, and acknowledged Full modes
  now run through one main-process gate with per-connector overrides, fixed tool
  metadata, dynamic critical escalation, non-bypassable hard boundaries,
  cancellation-safe polished approval cards/native fallback, and bounded private
  activity. The 419-test suite passes; packaged verification proved a safe
  automatic Gmail read and exact cancelled Gmail-send flow with no network write.

## OMI-046 — Retired Gemini fallback broke live Code Agent tasks — Resolved

- Severity: High
- Reproduction: Start a packaged Google Code Agent task when the selected model
  is `gemini-2.5-flash` on an account where Google no longer offers that model to
  new users.
- Expected: OmniCode selects a currently available account-visible tool-capable
  model, or surfaces the real provider error.
- Actual: The first live Code Agent run reached Google and received a real 404
  explaining that Gemini 2.5 Flash was no longer available to new users.
- Suspected cause: Maintained fallback ordering favored an obsolete generation.
- Relevant files: `src/main/services/model-catalog-manager.ts`,
  `src/main/services/model-catalog-manager.test.ts`,
  `scripts/smoke-code-agent.mjs`.
- Current status: ✅ Resolved — Google fallback/discovery sorting now prefers
  `latest` aliases and 3.6 before older stable generations. A subsequent
  packaged task used an available current model and completed a real
  inspect/write/read workflow. A later 429 quota response remained an honest
  external account limit rather than being misreported as application success.

## OMI-047 — Structured arbitrary macOS app control is unavailable

- Severity: Medium; blocks only external-application interaction, not app launch
- Reproduction: Ask Code Agent to observe an arbitrary external application and
  click/type inside it after launch.
- Expected: A permission-aware native ComputerTool observes and interacts with
  only the approved application/session.
- Actual: OmniCode can safely launch an allowlisted app or workspace document,
  report Accessibility/Screen Recording state, and open the exact permission
  pane, but reports structured computer control as `not-implemented`.
- Suspected cause: Electron has no safe built-in macOS Accessibility controller;
  a native AX bridge with explicit window/element scoping, capture lifecycle,
  and independent security review is required.
- Relevant files: `src/main/services/code-application-manager.ts`,
  `src/main/services/code-agent-tool-service.ts`,
  `src/main/services/agent-command-policy.ts`.
- Current status: 🔵 Blocked / External Requirement — unrestricted AppleScript,
  `osascript`, screen capture, and shell automation remain blocked. Implementing
  a trustworthy native ComputerTool is a separate audited platform integration;
  OmniCode does not present launch-only behavior as full UI control.
