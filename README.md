# OmniCode

OmniCode is a complete macOS-first code editor with Monaco editing, real PTY
terminals, project run/build tools, Git, local Ollama models, optional cloud AI,
agent workflows, and reviewable AI diffs. It targets **macOS Sonoma 14 or
newer** on both Intel and Apple silicon.

This repository builds a real Electron desktop application. File, process,
terminal, Git, credential, and provider operations run behind a sandboxed,
typed preload boundary; the React renderer has no direct Node.js access.

## What is included

- Native macOS menus, dialogs, Finder actions, file associations, drag and drop,
  notifications, system theme support, Retina assets, and familiar shortcuts.
- Workspace explorer with create, rename, move, duplicate, trash, reveal, copy
  path, and Open With actions.
- Multiple Monaco tabs with a fully bundled offline editor and language workers,
  syntax highlighting, diagnostics, folding, minimap, bracket matching,
  find/replace, autosave, Save As, and AI autocomplete.
- Workspace search and replace with `ripgrep` acceleration and a portable
  fallback; `.gitignore` and `.omnicodeignore` are respected.
- Multiple named and restartable terminal sessions backed by `node-pty`, plus
  searchable terminal output.
- Output, Problems, and captured Run Log panels.
- Automatic runtime/tool detection for Apple toolchains, Python, Node.js,
  Java, .NET, Rust, Go, Ruby, PHP, Docker, Git, Homebrew, and Ollama.
- Run/build recipes for common source files and project manifests, including
  npm projects, Cargo, Go, .NET, Java, C/C++, Swift, Python, Ruby, and PHP.
- Static live-reload serving and package-script development servers with
  start, restart, stop, port discovery, and browser launch.
- Git status, staging, unstaging, commit, initialization, cloning, branches,
  fetch, pull, and push.
- Local AI through Ollama and opt-in OpenAI, Anthropic, and Google Gemini
  adapters. Cloud credentials are encrypted by macOS Keychain-backed storage.
- Local model catalog, download progress/cancel, delete, load/unload, defaults,
  and hardware-aware recommendations.
- Workspace indexing, selected context attachments, chat, inline editing,
  Agent Mode, permission tiers, and reversible file/hunk diff review.
- Six-step first-launch setup for theme, tools, runtimes, local AI, cloud AI,
  and a starting workspace, with real tool installers and local model downloads.

Supported editing modes include HTML, CSS, JavaScript, TypeScript, JSX, TSX,
Python, Java, C, C++, Objective-C, Objective-C++, Swift, C#, Rust, Go, PHP,
Ruby, Kotlin, Lua, JSON, XML, YAML, Markdown, SQL, shell/Bash/zsh/Fish,
Dockerfile, TOML, INI, Makefile, Gradle, Vue, Svelte, PowerShell, and Windows
Batch. PowerShell and Batch remain editable on macOS even when no native
runtime is available.

## Requirements

For the packaged app:

- macOS 14 Sonoma or newer
- An Intel x86-64 Mac or Apple silicon Mac
- No compiler or AI service is required just to edit files

For development and local packaging:

- Node.js 22.12 or newer; Node.js 24 LTS is recommended
- npm
- Xcode Command Line Tools
- Git

The Command Line Tools provide Clang and the build tools required by the native
`node-pty` dependency. Verify them with:

```zsh
xcode-select -p
clang --version
node --version
npm --version
```

If necessary, start Apple's installer with `xcode-select --install` and finish
the macOS installation before running `npm install`.

## Development setup

From the repository root:

```zsh
npm install
npm run dev
```

The first command installs dependencies and rebuilds native modules for
Electron. The second builds the main and preload processes, starts the renderer
development server, and launches OmniCode.

If Electron reports a `NODE_MODULE_VERSION`, `dlopen`, or wrong-architecture
error, rebuild the terminal module:

```zsh
npm run rebuild:native
```

## Validation and tests

Run the complete local confidence suite with:

```zsh
npm run typecheck
npm test
npm run build
```

The tests cover security-sensitive workspace paths, file operations, search,
settings validation, Git, runtimes, run recipes, shell environment recovery,
hardware recommendations, AI adapters/model lifecycle, indexing, and reversible
diff application.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Launch the development app with hot reload |
| `npm run typecheck` | Type-check the entire TypeScript project |
| `npm test` | Run all Vitest tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run build` | Type-check and create production bundles in `out/` |
| `npm run preview` | Launch the production bundles without packaging |
| `npm run rebuild:native` | Rebuild `node-pty` for Electron |
| `npm run dist:dir` | Create an unpacked app for local smoke testing |
| `npm run dist:x64` | Create Intel DMG and ZIP artifacts |
| `npm run dist:arm64` | Create Apple silicon DMG and ZIP artifacts |
| `npm run dist` | Package the architecture of the current Mac |

## Building the macOS app

For an unpacked application:

```zsh
npm run dist:dir
```

For release archives, build the architecture you need:

```zsh
npm run dist:x64
npm run dist:arm64
```

Artifacts are written to `dist/` with names such as:

```text
OmniCode-0.1.1-x64.dmg
OmniCode-0.1.1-x64.zip
OmniCode-0.1.1-arm64.dmg
OmniCode-0.1.1-arm64.zip
```

`node-pty` contains native code, so each artifact must contain the matching CPU
slice. Smoke-test Intel output on Intel hardware and Apple silicon output on
Apple silicon before public distribution.

Local artifacts can be built without an Apple Developer account. They remain
unsigned, so macOS may ask the user to confirm the first launch: in Finder,
Control-click OmniCode and choose **Open**. Public distribution requires a
Developer ID Application certificate, Apple notarization, and stapling. The
package already uses a stable bundle identifier and Hardened Runtime so signing
can be added without changing application behavior.

## Using OmniCode

1. Launch the app and complete the setup guide. Local and cloud AI are optional.
2. Choose **File → Open Folder…** or drag a folder onto the window.
3. Use the Explorer to open a file. The Run button chooses a recipe from the
   active file and project manifests.
4. Open the Terminal from the Terminal menu or with Command–backtick. Sessions
   start in the workspace.
5. Use the activity bar for Search, Git, Run, Tools, Models, and AI.

Common shortcuts:

| Shortcut | Action |
| --- | --- |
| `⌘ S` | Save |
| `⌘ ⇧ S` | Save As |
| `⌘ O` | Open file |
| `⌘ ⇧ O` | Open folder |
| `⌘ P` | Quick Open |
| `⌘ ⇧ P` | Command Palette |
| `⌘ F` | Find in editor |
| `⌘ ⇧ F` | Search workspace |
| `⌘ W` | Close editor tab |
| `⌘ ,` | Settings |
| Command–backtick | Toggle terminal |
| `⌘ I` | Inline AI edit |
| `⌃ R` | Run current file or project |

## AI setup

### Install tools from setup

Open **OmniCode → Setup & Install Tools…** at any time. Missing supported
tools have an **Install** button, live status, cancellation, and retry. Most
runtimes install through Homebrew; if Homebrew is missing, OmniCode downloads
its official macOS installer first. Finish that installer and select Install
again for the runtime. Java, .NET, and Docker downloads open their native
installers so macOS can handle administrator approval. Apple Command Line
Tools use Apple's Software Update installer. Full Xcode remains an App Store
installation; the optional `python` alias does not need a separate install.

Native installers may require license acceptance, administrator approval, or
moving an app into Applications. Detection refreshes when you return to
OmniCode, and a **Refresh** button is available. Cancelling a running install
stops the current operation; it does not uninstall dependencies already added.

### Local AI with Ollama

In setup's **Local AI** step, choose **Install Ollama** or **Start Ollama**.
OmniCode uses Homebrew when available, or downloads the official Ollama DMG.
Once Ollama is running, choose a recommended model and **Download model**.
Downloads show progress, can be cancelled/retried, and continue between setup
steps. The first model becomes the default only when none has been selected.

Ollama can also be installed manually with its macOS application or Homebrew:

```zsh
brew install ollama
ollama serve
```

Open the Models view in OmniCode to download a recommended coding model. Model
downloads show live progress and can be canceled. The hardware panel ranks
models from recommended to not recommended based on memory, CPU architecture,
and optional GPU information. Local prompts and attachments go only to the
loopback Ollama service.

### Cloud providers

Open **OmniCode → Settings → AI Providers** and enter an OpenAI, Anthropic, or
Google Gemini API key. The key is stored as a generic-password item directly in
macOS Keychain through `/usr/bin/security`; the secret is passed on standard
input so it does not appear in process arguments or logs. It is never written
to workspace settings. The model field accepts a provider model ID, so it can
be changed as providers add new models.

Saving verifies that the exact key can be read back from Keychain before
reporting success. If upgrading from 0.1.0 and chat reports a missing key,
re-enter it once: the previous save flow could store an empty value. A saved
key confirms local storage, not provider account access, credits, or model
availability; provider errors are shown in chat.

Before OmniCode sends attached code or workspace context to a cloud provider,
it shows a confirmation naming the provider and the selected attachments.
Autocomplete is off by default and requires a separate opt-in, especially for
cloud providers.

### Workspace context and ignore rules

Create `.omnicodeignore` in a workspace for private or generated content that
must not appear in search or AI indexing. It uses gitignore-style patterns.
`.git`, dependencies, build output, environment files, credentials, private
keys, and other common sensitive files are excluded by default.

AI changes do not write directly into the editor. They become a proposal where
files and individual hunks can be accepted or rejected. Applied proposals keep
the original content for a one-step undo.

## Workspace settings

Workspace settings live in `.omnicode/settings.json`, are validated before
write, and apply as soon as they are saved. Example:

```json
{
  "editor": {
    "autosave": true,
    "tabSize": 2
  },
  "languages": {
    "python": {
      "tabSize": 4,
      "insertSpaces": true
    }
  },
  "run": {
    "command": "npm",
    "args": ["test"],
    "environment": {
      "NODE_ENV": "test"
    }
  },
  "developmentServer": {
    "script": "dev",
    "port": 5173
  },
  "ai": {
    "provider": "ollama",
    "chatModel": "qwen2.5-coder:7b",
    "autocompleteModel": "qwen2.5-coder:1.5b",
    "exclusions": ["private/**", "fixtures/generated/**"]
  },
  "toolchains": {
    "python3": "/opt/homebrew/bin/python3"
  },
  "agentPermissions": "ask"
}
```

Custom commands are user-authored and run only after an explicit Run action.
OmniCode never installs compilers, runtimes, or system packages automatically.
Do not put secrets in `run.environment`; workspace settings are normal project
files and may be committed to source control.

## Current release boundaries

- The local build is unsigned and not notarized. Signing credentials are not
  included in the repository.
- Agent Mode is review-first: it retrieves context, creates a plan, stages
  multi-file diffs, and suggests commands. It does not run an unattended
  command/fix loop; every command still requires a separate user confirmation.
- OmniCode does not implement the VS Code extension host, language-server
  protocol clients, or native debugger adapters in version 0.1. Monaco
  validation, runtime output, Problems, and captured Run Log remain
  available without them.
- Workspace indexing is an in-memory snapshot capped at 4,000 files and 32 MiB
  of source content. Opening another workspace atomically cancels the prior
  scan.
- The Explorer omits common generated/vendor trees such as `.git`,
  `node_modules`, `dist`, and `build` to keep its recursive tree bounded.

## Project architecture

```text
src/
  main/
    index.ts                 Electron lifecycle and validated IPC handlers
    menu.ts                  Native macOS application menus
    services/                Files, PTY, Git, run, server, AI, diff, settings
  preload/
    index.ts                 Narrow typed contextBridge surface
  renderer/
    index.html               Content Security Policy and renderer entry
    src/
      App.tsx                Workbench state and command routing
      components/            Explorer, terminal, Git, AI, models, settings
      lib/                   Language registry
  shared/
    contracts.ts             Serializable cross-process contracts
scripts/
  smoke-packaged.mjs         Packaged renderer, IPC, PTY, and server smoke test
  smoke-open-file.mjs        Cold-start file-open and offline Monaco smoke test
build/
  icon.icns                  Packaged macOS icon
docs/
  ARCHITECTURE.md            Security boundaries and design decisions
```

Electron is used because Monaco and xterm are first-class in Chromium,
`node-pty` supplies real terminal semantics, and the main process can reliably
supervise compilers, Git, servers, Ollama, and Keychain access. The accepted
cost is a larger bundle than a native Swift or Tauri shell.

## Security

- Renderer windows use `sandbox: true`, `contextIsolation: true`, and
  `nodeIntegration: false`.
- The preload exports named, typed capabilities rather than raw Electron IPC.
- Workspace paths are canonicalized and checked against the granted root;
  symlink and path traversal escapes are rejected, including workspace metadata
  and compiler-output directories.
- Saves use temporary files plus atomic replacement, with external-change and
  dirty-document guards.
- File selection outside a workspace creates a short-lived explicit grant.
- Provider credentials are stored directly in macOS Keychain.
- Ollama endpoints are restricted to HTTP loopback addresses.
- Cloud context is opt-in and visibly confirmed.
- Agent actions are classified by risk. Destructive, `sudo`, system-changing,
  Keychain-read, and outside-workspace actions always require approval.
- AI file changes are proposed as reviewable, reversible diffs.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full decision record.

## Troubleshooting

### A terminal cannot start

Run `npm run rebuild:native` for a development checkout. In the packaged app,
verify that the artifact architecture matches the Mac with `uname -m`.

### A tool works in Terminal but OmniCode cannot find it

Finder-launched apps inherit a limited environment. OmniCode resolves the
user's login shell and common Homebrew locations, but unusual installations can
be mapped in `.omnicode/settings.json` under `toolchains`.

### A protected folder is empty or cannot be opened

Use the native Open Folder dialog so macOS can grant access. In **System
Settings → Privacy & Security → Files and Folders**, verify that OmniCode has
the intended permission. External volumes must also be mounted and readable.

### Ollama is unavailable

Start Ollama and verify `http://127.0.0.1:11434` is reachable. The Models view
shows the detected version and provides installation guidance when the CLI or
service is missing.

### A cloud request fails

Check the stored key, provider model ID, network connection, account access,
and provider quota. Replace or delete a key in Settings; secrets are never read
back into the UI.

### macOS blocks an unsigned local build

Confirm that the app came from this checkout, then Control-click it in Finder
and choose **Open**. Public artifacts should be signed and notarized instead of
asking users to bypass Gatekeeper.

## License

MIT. See [LICENSE](LICENSE).
