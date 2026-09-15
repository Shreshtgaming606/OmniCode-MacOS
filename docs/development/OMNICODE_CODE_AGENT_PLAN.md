# OmniCode Code Agent and Glasses Mode Implementation Plan

Last updated: 2026-09-14

## Verified starting point

The current Code Agent is implemented in the renderer. It sends one bounded
workspace-context request through `AIManager.chat`, parses a strict JSON plan,
stages relative-path changes through `DiffManager`, and presents model-suggested
commands for a separate native confirmation. It does not execute a provider tool
loop, receive terminal results, iterate after failures, use the Managed Browser,
launch apps, access an approved external folder, or persist task activity.

Reusable trusted components already exist:

- `ToolRegistry` and main-process `PermissionManager`, including Ask, Approve for
  me, Full access, risk escalation, and non-bypassable hard boundaries;
- provider-native OpenAI, Anthropic, Gemini, and compatible Ollama tool turns;
- real `node-pty` terminal sessions with output, input, resize, interrupt, exit,
  workspace boundaries, and shell environment recovery;
- bounded main-process filesystem, Git, run, dev-server, diff, and workspace
  index services;
- isolated visible Managed Browser with DNS/private-network protections;
- private atomic Work permission/activity persistence and secret redaction;
- Code/Work mode separation and the shared OmniCode design system.

## Architecture

The Code Agent will use one trusted path:

`provider -> CodeAgentManager -> ToolRegistry -> PermissionManager -> Code tool service -> result -> provider`

Model output never selects approval mode, tool risk, filesystem grants, or
execution authority. Tool descriptors are application-owned. Browser pages,
files, terminal output, Git output, documentation, and application text remain
untrusted data and are wrapped as tool results, never system instructions.

## Implementation phases

1. **Contracts and persistence**
   - Add versioned Code Agent task, event, state, visibility, focus-behavior, and
     safe-result contracts.
   - Add a private atomic bounded task/timeline manager with redaction,
     corruption recovery, per-task event limits, and no raw secrets.
2. **Task controller**
   - Add a main-process `CodeAgentManager` using provider-native tool turns.
   - Add bounded step/call/retry/output limits and truthful completion states.
   - Implement pause-after-current-action, resume, stop/cancel, and sender-bound
     lifecycle cleanup.
3. **Code tools**
   - Register terminal start/input/observe/interrupt/stop tools over real PTYs.
   - Register bounded workspace/external filesystem read/write/list/create/move
     tools; all writes remain diff-visible or explicitly authorized.
   - Register Git status/diff/operation, dev-server start/status/stop, runtime,
     build/test, diagnostics, and app-launch tools over existing managers.
   - Give every tool fixed category, risk, reversibility, external-side-effect,
     scope, and result bounds.
4. **External filesystem grants and macOS boundary**
   - Keep the workspace as the default root.
   - Require Permission Manager authorization and, when needed, a native folder
     picker for one exact external root; persist no blanket filesystem escape.
   - Block sensitive/system roots, Keychain/browser-profile paths, traversal,
     mass destructive actions, `sudo`, and permission escalation in every mode.
   - Add structured, allowlisted application launch/open-file/open-URL behavior.
   - Detect relevant macOS permission state and link to the correct System
     Settings pane. Accessibility/screen control will remain unavailable unless
     a reliable, permission-aware structured controller exists.
5. **Managed Browser for Code Mode**
   - Reuse the isolated Browser connector in Code Mode.
   - Permit public HTTPS plus loopback HTTP/HTTPS for real local development.
   - Add bounded structured navigation, page read/find, safe click/type where
     supported, reload, and console/error observation; keep payments, downloads,
     credentials, unsafe submissions, popups, and private-network access gated
     or blocked.
6. **Glasses Mode UI**
   - Add independent Standard/Glasses visibility, approval, model, focus, and
     Running/Paused controls to Code Agent.
   - Render a bounded live timeline for actions, commands, outputs, diffs,
     browser pages, launches, errors, retries, approvals, and results.
   - Provide expand/copy/open-in-terminal/open-file actions without exposing
     chain-of-thought or secrets.
   - Persist safe task summaries and timelines under Code Mode → Agent → Activity.
7. **Verification and release**
   - Add unit tests for contracts, policy, grants, redaction, stores, task state,
     tools, prompt injection, and all approval modes.
   - Add real disposable integration workflows for edit/test, localhost Browser,
     official documentation read, approved external file, app launch, timeline,
     pause/resume, and stop.
   - Rerun full Code/Work regression, typecheck, production build, packaged Intel
     smoke, architecture/archive/icon/credential checks, and dual installers.
   - Update status, matrix, issues, changelog, architecture, and release readiness
     continuously as results become known.

## Explicit safety and product boundaries

- Glasses Mode is observability only and never changes approval authority.
- No hidden chain-of-thought is requested, stored, or displayed.
- Commands and outputs are redacted and bounded before persistence/rendering.
- The agent never answers password/authentication prompts automatically.
- The agent cannot use arbitrary AppleScript, `osascript`, `sudo`, Keychain-read,
  shell-evaluation, or unrestricted UI automation as a substitute for structured
  tools.
- Completed edits are preserved when stopped; rollback remains an explicit user
  action through the existing diff/undo system.
- Unsupported macOS computer-control operations will be reported as blocked with
  the exact permission/implementation requirement rather than faked.

## Reasoning Summary and dynamic plan addition — 2026-09-14

Verified baseline: Code Agent 0.5.0 persists trusted operational events and
Standard/Glasses visibility, but it has no first-class plan state. The final
provider answer is visible, while task interpretation, current/next step,
user-facing decision summaries, and plan changes are not structured or
persisted. Pause/resume/stop exist; Modify Plan and Skip Step do not.

Implementation order:

1. Add bounded provider-neutral plan contracts to each Code Agent task. Persist
   sanitized task understanding, reasoning summary, steps, current/next step,
   progress, decisions, and change reasons in the existing private activity
   store with backwards-compatible migration.
2. Register one Code-only `agent.update-plan` Tool Registry descriptor. The
   model will use this application-owned schema for user-facing plan summaries;
   it provides no system authority and never bypasses Permission Manager.
3. Extend the shared provider loop with a bounded user-intervention queue. A
   plan edit or skipped step pauses at the atomic-action boundary, safely marks
   already-proposed calls as skipped when necessary, and returns the user's
   revised course to the model before more work.
4. Add main/preload APIs for Modify Plan and Skip Step, retaining sender/task
   ownership and existing pause/resume/stop behavior.
5. Add a compact plan/status panel shared by Standard and Glasses, expanded
   planning detail in Glasses, inline plan modification, progress, decisions,
   change reasons, and a final evidence summary derived from real activity.
6. Add unit/integration coverage for initial and changed plans, step progress,
   user intervention, skipped calls, persistence, redaction, Standard/Glasses,
   failed/final reports, approval independence, and provider-neutral schemas;
   then rerun production and packaged verification.

Safety boundary: “Reasoning Summary” is a deliberately short model-authored
explanation requested through a fixed schema. Raw provider reasoning tokens,
hidden chain-of-thought, system/developer prompts, and unbounded free-form traces
are neither requested nor stored.

Implementation result — 2026-09-15:

- Steps 1–6 are complete in OmniCode 0.5.1.
- The full regression suite passes: 459 tests passed, one native Keychain test
  is intentionally excluded from the ordinary suite, and zero tests failed.
- TypeScript and production bundling pass. Intel and Apple Silicon DMG/ZIP
  artifacts embed 0.5.1, contain matching Electron/native PTY architectures,
  preserve the original icon, and pass archive/disk-image/checksum validation.
- A packaged Intel five-turn controlled local-provider audit clicked Skip Step
  and Modify Plan, paused/resumed, proved the stale proposal did not execute,
  rendered changed/progress plan state and a real runtime-detection action,
  showed 9 Glasses versus 7 Standard events, reached 2/2 progress, displayed the
  complete final report, had no horizontal overflow, and logged zero renderer
  errors.
- Remaining release blocks are unchanged external requirements: Apple signing/
  notarization, matching Apple Silicon execution hardware, and the separately
  documented service/account gates. They do not block this planning layer.
