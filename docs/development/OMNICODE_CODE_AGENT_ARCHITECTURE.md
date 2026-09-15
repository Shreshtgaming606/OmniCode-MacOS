# OmniCode Code Agent and Glasses Mode Architecture

Last updated: 2026-09-14

## Purpose

Code Agent is OmniCode Code Mode's tool-using development assistant. Standard
and Glasses are two views of the same agent execution; they do not change model
authority or permission policy. Glasses shows observable operations and never
claims to reveal private model reasoning.

## Trusted execution path

Every action follows one main-process route:

`provider -> CodeAgentManager -> ToolRegistry -> PermissionManager -> CodeAgentToolService -> result -> provider`

The model can propose a registered tool call and arguments. It cannot define
tools, set risk, choose approval outcomes, grant paths, launch arbitrary apps, or
call an executor directly. The application owns every descriptor's category,
risk, reversibility, side-effect, schema, result bound, and confirmation rule.
The same provider-native tool loop used by Work Mode handles OpenAI, Anthropic,
Gemini, and tool-capable Ollama models; OmniCode did not add a second AI agent
protocol.

## Tools

### Workspace and external files

- `files.list`, `files.read`, and `files.search` return bounded, non-sensitive
  workspace data.
- `files.write` and `files.delete` apply through the existing transactional
  Diff Manager. Each result has a proposal ID and line counts and remains
  reviewable and undoable.
- `external.grant` always opens a native folder picker. The selected canonical
  root is stored only for one running task; the model receives an opaque grant
  ID and folder label, never a reusable absolute capability.
- `external.list`, `external.read`, `external.write`, `external.mkdir`, and
  `external.move` are confined to that exact grant. Symlink escape, traversal,
  credentials, private configuration, system roots, binary context, and
  oversized content are blocked.
- `external.open-workspace` always asks before changing the current project.

External writes are atomic but are not part of the current workspace Diff
Manager, so their approval card and activity entry state that they are not
undoable. Stopping a task revokes all its external grants.

### Terminal, build, and test

Agent commands use task-owned `node-pty` sessions with OmniCode's recovered
login-shell environment. The agent can start, observe, send non-secret input,
interrupt with real Ctrl+C, stop, or wait for the actual exit status. Build and
test tools use the same PTY path and stream bounded redacted progress to the
timeline. Task stop cleans up every owned process.

The command validator rejects privilege escalation, `sudo`, arbitrary
AppleScript, Keychain/credential discovery, secret environment expansion,
download-and-execute pipelines, nested evaluation shells, global package
installation, destructive system commands, and sensitive account paths.
Project dependency commands have a separate fixed allowlist and always require
direct approval. Password, passphrase, token, and credential prompts cannot be
answered by the agent.

### Git, server, runtime, and diagnostics

- Git status/diff/stage/unstage/commit/init/fetch/pull/push route through the
  existing Git Manager and report only after the real operation completes.
- Development server detect/start/status/stop routes through the existing
  Server Manager. A server is task-owned and stopped during task cleanup.
- Runtime detection uses the existing real executable probes.

### Managed Code Browser

Code Mode reuses the isolated Managed Browser with a separate storage
partition. Tools provide generated web search, public HTTPS navigation, visible
page reads, find, safe non-form click/type, reload, and bounded console errors.
Loopback HTTP/HTTPS is additionally allowed for localhost testing. Other
private-network hosts, credential-bearing URLs, `file:` URLs, popups, downloads,
permission requests, credential fields, form submission, account/security,
financial, and destructive controls remain blocked.

Browser pages and search results are untrusted tool output. The Code Agent
system contract explicitly prevents them, files, Git data, app text, and
terminal output from overriding user intent or permission policy.

### macOS applications and computer control

Application launch uses `/usr/bin/open` with an argument array, never a shell.
The fixed allowlist is Safari, Google Chrome, Finder, Terminal, Simulator,
Xcode, Preview, and TextEdit. An optional target must exist inside the current
workspace. Focus `Never` adds background launch behavior.

OmniCode reports Accessibility and Screen Recording state and can open only the
matching System Settings privacy pane. Structured click/type/screen observation
for arbitrary external applications is deliberately reported as
`not-implemented`: Electron exposes no safe native Accessibility controller,
and OmniCode does not fall back to unrestricted `osascript`, screenshots, or
shell automation. Adding that capability requires a separately audited native,
permission-aware ComputerTool implementation.

## Approval and focus controls

Approval and visibility are independent:

- **Ask** prompts for every change or consequential action.
- **Approve for me** lets routine reversible work continue while higher-risk,
  communication, sensitive, destructive, and external actions retain gates.
- **Full Access** allows ordinary registered tools but cannot bypass
  always-confirm, critical, financial, account-security, irreversible
  destructive, credential, system-root, or command-policy boundaries.
- **Standard** shows concise waiting, failure, and result activity.
- **Glasses** shows the complete bounded operational timeline.
- **Automatic**, **When needed**, and **Never** control whether browser or app
  actions foreground their surface. Nonvisual tools never steal focus.

## Glasses timeline and task control

Each task emits bounded events for task, file, terminal, Git, browser,
application, server, build, test, diagnostic, approval, failure, and result
states. Commands, paths, URLs, output, proposal IDs, status, and short summaries
are visible where relevant. Outputs can be expanded/copied and diff proposals
can be opened in the existing review UI.

Pause finishes the current atomic tool action and blocks the next action.
Resume releases that boundary. Take Over uses the same safe pause and is shown
while running; Resume returns control to the agent. Stop aborts the provider and
current tool, prevents future calls, stops owned processes/server, revokes
grants, and preserves already completed edits for explicit review or undo.

## Storage, privacy, and performance

Task metadata lives in a private `0600`, atomic, main-process JSON store. It is
limited to 100 tasks, 400 events per task, 16 MiB total, 32 KiB per event output,
and 8 KiB final summaries. Raw prompts and workspace roots are not persisted.
Credentials, tokens, authorization headers, secret assignments, and control
characters are redacted before storage and rendering. Corrupt history fails
closed to an empty recoverable store. The PTY and provider loops are independent
of React rendering, so the UI never receives unbounded terminal streams.

## Verification

Automated coverage includes task lifecycle, provider tool-loop reuse, all
permission modes in the shared backend policy, workspace boundaries, real
temporary-file/diff/undo operations, external grants and writes, terminal
ownership/input/interrupt/secret prompts, command policy, Code Browser URL and
localhost boundaries, web search, app allowlisting/focus/permission panes,
timeline filtering, persistence, corruption recovery, bounds, redaction,
cancellation, and untrusted-content instructions.

A packaged Gemini run completed a real Code Agent task against a disposable
workspace: the model inspected a real file, created exact requested bytes
through the diff-backed tool, read the result, persisted its timeline and final
state, and exposed the proposal for undo. A later retry reached Google's real
quota limit and was reported as a provider failure rather than fake success.
