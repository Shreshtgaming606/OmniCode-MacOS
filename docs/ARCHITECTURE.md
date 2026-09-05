# OmniCode architecture

This document records the architecture implemented by OmniCode 0.1 for macOS
Sonoma. It describes the shipped local build, including its deliberate
boundaries, rather than a future extension-host or autonomous-agent design.

## Goals

OmniCode supports this complete local development loop:

```text
open folder → edit → save → run/build → inspect output
    → ask AI → review a proposed diff → apply/reject → inspect Git
```

The design prioritizes:

1. Safe access to user-selected macOS workspaces.
2. Real Monaco editing and PTY terminal semantics.
3. Explicit local-versus-cloud AI disclosure.
4. Recoverable saves and reviewable AI changes.
5. Finder-compatible tool and shell discovery.
6. Separate Intel and Apple-silicon release artifacts.

## ADR-001: Electron

**Decision:** Electron 44, React 19, TypeScript, electron-vite, and
electron-builder.

Electron is a fit for this editor because Monaco and xterm.js run in their
first-class Chromium environment, while the main process can supervise native
PTYs, Git, compilers, development servers, Ollama, native dialogs, Finder
actions, notifications, and macOS Keychain. A shared TypeScript contract keeps
renderer, preload, and main-process calls synchronized.

The accepted tradeoffs are a larger bundle and higher baseline memory than a
native Swift or Tauri shell. Electron and the native `node-pty` module also
need architecture-specific security updates and release testing.

## Process boundary

```text
┌──────────────────────── Renderer ─────────────────────────┐
│ React workbench • Monaco • xterm display • transient state │
│ no Node.js • no Electron objects • no raw filesystem       │
└────────────────────────────┬───────────────────────────────┘
                             │ named contextBridge methods
┌────────────────────────────▼───────────────────────────────┐
│ Preload                                                     │
│ typed serializable calls • scoped event subscriptions       │
│ no generic invoke/send/listener exposed                     │
└────────────────────────────┬───────────────────────────────┘
                             │ validated IPC
┌────────────────────────────▼───────────────────────────────┐
│ Main process                                                │
│ workspace • files • PTYs • run/server • Git • AI • Keychain│
└───────────────┬────────────────────┬────────────────────────┘
                │                    │
         local processes       loopback / HTTPS
         shells, Git, tools     Ollama, cloud AI
```

Every renderer uses:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- a local Content Security Policy

The main window denies new windows, blocks navigation away from the exact
packaged renderer (or exact development origin/path), and denies Chromium web
permission requests by default. Every handled IPC invocation verifies that it
came from the main frame of the current trusted window. Fire-and-forget
terminal input and resize events use the same sender check and swallow stale
PTY races instead of crashing the main process.

The preload exposes only domain methods on `window.omnicode`. It never exposes
`ipcRenderer`, `fs`, `child_process`, `shell`, or a generic channel API.

## Workspace authority

The current application has one main window and one active workspace
capability. A folder becomes active only after the user:

- chooses it in a native macOS dialog;
- opens it through Finder/file association or drag and drop; or
- reopens an entry already recorded in local recent-workspace history.

The main process canonicalizes the workspace with `realpath`. Every file,
terminal, run, Git, server, settings, diff, and index operation is checked
against that root. Canonical descendant checks reject `..` traversal,
same-prefix sibling paths, and symlink escapes.

A single file selected outside the workspace receives its own explicit
capability. Save As also grants the path chosen in the native save dialog.
Destination grants for clone/create-project operations expire after five
minutes and are consumed once.

## File integrity

Text editing is limited to non-binary files up to 8 MiB. A normal save:

1. verifies the file's modification time when it was opened;
2. writes a temporary sibling with the original mode;
3. atomically renames it over the original; and
4. removes the temporary file after any failure.

This prevents partial files and rejects external-edit conflicts. Clean open
documents reload after external changes; dirty documents are preserved with a
visible conflict warning. Rename and move preflight their destinations and
refuse to replace an existing item. Deletes use macOS Trash.

Workspace switches, editor-tab closes, window closes, and application quit all
guard unsaved documents. A blocked close presents Save All, Discard Changes,
and Cancel. A failed save keeps the window open and resets the pending quit.

The Explorer recursively omits common generated/vendor trees (`.git`,
`node_modules`, `dist`, `build`, caches, and virtual environments) to keep
the first version's eager tree bounded.

## Terminal and process behavior

Each terminal is a real `node-pty` session owned by the main process. Sessions
support shell choice, multiple tabs, rename, restart, split display, search,
resize, colors, and interactive input. zsh and Bash start as login shells.

A Finder-launched app receives a sparse environment, so OmniCode resolves the
user's login/interactive shell environment once and merges safe common macOS
paths, including both Homebrew locations. Tool detection and subprocesses use
that environment without logging it.

Run recipes are executable-plus-argument arrays. Built-in recipes avoid shell
interpolation. User-authored workspace commands and Agent-suggested commands
are visibly labeled; Agent commands are screened for destructive/system
patterns and always require a separate confirmation.

PTYs, file watchers, and development servers stop when the window closes.
They also stop during final application quit.

## Development server

The static server:

- binds only to `127.0.0.1`;
- canonicalizes its root and every served real path;
- refuses traversal and symlink escapes;
- denies `.git`, `.omnicode`, environment files, package-manager
  credentials, private keys, Keychain exports, and common credential stores;
- injects a small EventSource live-reload client only into HTML.

Package-script servers use the detected package manager and a script already
declared by that workspace. They run in their own process group so Stop can
terminate descendants.

## AI architecture

### Local AI

Ollama traffic is restricted to loopback HTTP. The Models view reads installed
and loaded models, offers a curated coding catalog, shows hardware-aware
recommendations, streams pull progress, supports cancellation, and can
load/unload/delete models. Model deletion requires a native confirmation.

### Cloud AI and credentials

OpenAI, Anthropic, and Gemini use their HTTPS APIs. Provider model IDs remain
editable because cloud catalogs change independently of OmniCode releases.

API keys are generic-password items stored directly in macOS Keychain through
`/usr/bin/security`. New secrets are passed on standard input and are never
returned to renderer UI after storage. They are not persisted in localStorage,
workspace settings, or logs.

Writes use `security -i` with a hex-encoded password on stdin, then verify the
exact readback before reporting success. Missing/empty values are distinct from
Keychain access failures. An opt-in native test uses a disposable keychain to
verify save, replace, reopen, and delete for every cloud provider.

Setup installation requests resolve through a fixed tool allowlist in the main
process. Homebrew formulae run without a shell; casks are fetched and verified
by Homebrew before opening their native installer. Official Homebrew and Ollama
installers are streamed with size limits, HTTPS redirect validation, progress,
and cancellation. Native handoffs are reported as awaiting user action, never
as completed installations. Fresh-Mac detection skips Apple developer shims
when Command Line Tools are missing to avoid opening installation prompts from
background checks. Tool/model progress subscriptions live in App so navigation
between setup steps does not lose ongoing operations.

Before a cloud chat or Agent request, the renderer lists the exact active/open
file paths, retrieved relative paths, and the sizes/categories of selected
code, terminal output, diagnostics, and Git context. A canceled confirmation
sends nothing. Cloud autocomplete is disabled by default and has a separate
opt-in warning.

### Workspace index

The index is an in-memory, user/workspace-triggered snapshot. It captures paths,
source text, lightweight symbols, imports, and search tokens, then ranks a
small set of relevant files for a prompt.

Safety and resource limits:

- maximum 4,000 files;
- maximum 512 KiB per file;
- maximum 32 MiB aggregate source content;
- maximum 25,000 stored tokens per file;
- binary and common generated files are excluded;
- `.gitignore`, `.omnicodeignore`, and workspace AI exclusions apply;
- environment files, credential stores, and private-key formats are always
  excluded from automatic indexing.

Each scan writes to a private next snapshot. A generation token cancels an old
scan when another workspace starts indexing, and the snapshot is swapped only
when complete. Retrieval also requires an exact workspace-root match. These
rules prevent mixed or cross-workspace context.

Explicit file attachments are read only after main-process path authorization.
The final formatted context is capped before it is sent to a provider.

### Agent and diffs

Agent Mode in 0.1 is deliberately review-first:

1. save open dirty documents;
2. retrieve relevant workspace context;
3. request a structured plan and complete proposed file contents;
4. validate relative paths and operation limits;
5. stage a reversible diff proposal;
6. let the user accept/reject all, one file, or one hunk;
7. present commands as separately confirmed suggestions.

It does not run an unattended multi-turn command/fix loop. Permission settings
describe the desired interaction level, but destructive, `sudo`,
system-changing, Keychain-read, and outside-workspace actions always stop for
approval.

Diff proposals snapshot original contents, reject path escapes, detect
conflicting on-disk edits, and support undo after acceptance.

## Git, tools, and settings

Git uses the installed command-line client with argument arrays and bounded
output. Repository status, diffs, staging, commits, branches, clone, fetch,
pull, and push remain scoped to the active workspace.

Runtime detection checks executable availability and version output for Apple
toolchains, Xcode, Homebrew, Git, Python, Node/package managers, Java, .NET,
Rust, Go, Ruby, PHP, Docker, and Ollama. Missing tools produce actionable
guidance and are never silently installed.

Workspace configuration lives in `.omnicode/settings.json`, is size/type/range
validated, written atomically, and applies immediately. It may configure
editor indentation/autosave, language indentation, run commands, development
server script/port, AI defaults/exclusions, custom toolchain paths, and the
Agent permission preference. Literal environment values are supported but
must not contain secrets because this is an ordinary project file.

## Packaging

electron-builder produces architecture-specific `.app`, DMG, and ZIP output.
The package configuration includes:

- bundle ID `com.omnicode.editor`;
- Developer Tools category;
- macOS 14.0 minimum;
- Hardened Runtime;
- Retina `icon.icns`;
- source-code file associations;
- ASAR packaging with `node-pty` unpacked.

The repository does not contain a Developer ID certificate, so local artifacts
are unsigned and unnotarized. Public distribution must sign each architecture,
notarize with Apple, and staple the ticket.

## Verification contract

A releasable change must pass:

1. `npm run typecheck`;
2. `npm test`;
3. `npm audit --omit=dev`;
4. `npm run build`;
5. Intel and Apple-silicon packaging;
6. a packaged renderer, IPC, workspace, and PTY smoke test;
7. a native-hardware launch test for each distributed CPU architecture.

Unit tests exercise workspace escape prevention, atomic save conflicts,
collision-safe rename/move, secret exclusions, server boundaries, Git,
runtimes, recipes, shell environment recovery, settings, model management,
cloud-provider request shapes, retrieval, and reversible diffs.

## Deliberate 0.1 boundaries

OmniCode 0.1 does not include a VS Code extension host, language-server client,
debug adapter protocol, collaborative editing, automatic updater, or
unattended autonomous Agent loop. These are additive subsystems; none requires
expanding renderer privileges.
