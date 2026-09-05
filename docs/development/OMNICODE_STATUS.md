# OmniCode Stabilization Status

Last updated: 2026-09-05

Status legend:

- ✅ Working & Verified
- 🟡 Partially Working
- 🔴 Broken
- ⚪ Not Implemented
- 🔵 Blocked / External Requirement

This file records observed repository behavior, not specification intent. A UI
surface alone is not evidence that its backing operation works.

## Baseline

- Architecture: Electron 44 main process + sandboxed React 19 renderer + typed
  CommonJS preload bridge; TypeScript throughout; no Tauri or Rust.
- Build: electron-vite and electron-builder, macOS 14 minimum, separate x64 and
  arm64 DMG/ZIP artifacts, native `node-pty` unpacked from ASAR.
- Git: `master` had no commits at audit start. Baseline checkpoint `7e85887`
  now preserves all initial project files; no user changes were discarded.
- Baseline launch: packaged Intel app started on macOS Sonoma without a white
  screen or captured renderer exception. Setup, workspace IPC, real zsh PTY,
  localhost server, and remote-navigation blocking passed the existing smoke.
- Baseline tests: 185 automated tests passed; the native Keychain test was run
  separately and passed. This is evidence for covered paths only.

## Subsystem inventory

| Subsystem | Status | What exists / UI / backend connection | Tests performed and result | Bugs or fixes | Remaining work |
| --- | --- | --- | --- | --- | --- |
| Application startup | 🟡 Partially Working | Electron lifecycle, single-instance handling, secure window options, React workbench, macOS menu | Fresh packaged launch and console capture passed | None in this phase yet | Minimize/full-screen/close/reopen and repeated-launch soak |
| Packaging | 🟡 Partially Working | x64/arm64 DMG and ZIP via electron-builder | 0.1.1 archives, slices, checksums previously verified | None in this phase yet | Rebuild only after repairs; Apple-silicon hardware launch blocked |
| macOS integration | 🟡 Partially Working | Menus, dialogs, notifications, Finder open/reveal, file associations, theme | Packaged launch and cold file-open smoke previously passed | None in this phase yet | Exercise menus, Finder actions, dialogs, close behavior |
| File explorer / workspace | 🟡 Partially Working | Explorer UI and main-process open/read/write/create/rename/move/duplicate/trash/reveal/watch APIs | Packaged preload/backend workflow passed nested create, Unicode/punctuation paths, rename, move, duplicate, search/replace, binary rejection, workspace-boundary rejection, and real trash | No filesystem defect found in this slice | Native-dialog, Finder/reveal, drag/drop, autosave/conflict, and every context-menu path remain |
| Monaco editor | 🟡 Partially Working | Bundled Monaco, tabs, dirty state, save/autosave, language mapping, diff editor | Packaged workflow passed editing, dirty indicator, disk save, Cmd+F, Settings transition, tab close, and zero-error console capture | Fixed Monaco 0.56 provider disposal crash/noise by implementing `disposeInlineCompletions` | Undo/redo, replace/find-all, folding, selection/clipboard, all native menu shortcuts, autosave, and resize remain |
| Workspace search | 🟡 Partially Working | ripgrep plus fallback, include/exclude options, replace UI | Filesystem tests cover representative search boundaries | None in this phase yet | Real UI search/replace, ignored files, large workspace |
| Terminal | 🟡 Partially Working | xterm UI, multiple sessions, restart/kill/clear/search, real `node-pty` backend | Packaged zsh command passed | None in this phase yet | Interactive controls, PATH, history, resize, copy/paste, workspace switching |
| Shell environment | 🟡 Partially Working | Login-shell environment recovery and Intel/Apple Homebrew PATH additions | Unit tests pass | Earlier PATH recovery fixes are present | Validate inside packaged terminal against real host tools |
| Run / compile | 🟡 Partially Working | Run recipes for scripts, compilers, projects, custom configuration | Run-manager unit tests pass | None in this phase yet | Execute real installed languages and deliberate failures through app |
| Local development server | 🟡 Partially Working | Static server, live-reload injection, npm-script server detection/start/stop/restart | Static packaged smoke and service tests pass | None in this phase yet | Browser rendering, asset paths, live reload, conflicts, npm server lifecycle |
| npm project support | 🟡 Partially Working | Manifest script detection and npm/pnpm/yarn/bun selection | Parser paths covered indirectly | None in this phase yet | Real package scripts, install approval boundary, stop behavior |
| Git | 🟡 Partially Working | Status/diff/stage/unstage/commit/fetch/pull/push, branch UI, clone/init backend | Git-manager unit tests pass | None in this phase yet | Real disposable-repository UI and command lifecycle tests |
| GitHub | 🔵 Blocked / External Requirement | No GitHub-specific API; generic Git supports HTTPS/SSH URLs and existing system credentials | Not run | No GitHub-only UI found | Authenticated clone/fetch/pull/push need safe remote and user credentials |
| Runtime detection | 🟡 Partially Working | 33 allowlisted tool probes and clean installed/missing states | Runtime tests pass; packaged setup returned 33 tools | Fresh-Mac Apple shim prompting was fixed before baseline | Compare every requested tool with host command results |
| Runtime installers | 🟡 Partially Working | Setup install/progress/cancel/retry; Homebrew formula and native installer handoff paths | 19 installer/detection tests and URL checks passed previously | Secure fixed allowlist and cancellation already present | Real installs require explicit interactive approval; failure-path audit |
| Hardware detection | 🟡 Partially Working | CPU, architecture, RAM, macOS, Metal/GPU and model recommendations | Unit tests pass | None in this phase yet | Compare UI/API output with real host system data |
| macOS Keychain | ✅ Working & Verified | Save/has/delete IPC and per-provider Settings controls | Isolated native keychain save/replace/reopen/delete passed for all providers | Empty-write and delete-stderr bugs fixed in 0.1.1 | Packaged UI state/restart test with non-user test keychain if practical |
| OpenAI adapter | 🟡 Partially Working | Chat Completions HTTPS adapter, bearer auth, model field, error parsing | Mock request/auth/response tests pass | Key retrieval and empty/refusal handling fixed in 0.1.1 | Real minimal request blocked unless configured key is available |
| Anthropic adapter | 🟡 Partially Working | Messages API adapter and system-message separation | Mock request/auth/response tests pass | Empty/blocked replies now surface | Real request blocked unless configured key is available; token budget review |
| Google Gemini adapter | 🟡 Partially Working | GenerateContent adapter, API-key header, response parser | Mock request/auth/response tests pass | Key persistence and thought-part filtering fixed in 0.1.1 | Real request blocked unless configured key is available |
| Provider status UI | 🔴 Broken | Settings accurately reports Keychain storage state, but no real connection validation | Code inspection | “Credential stored” must not imply provider connectivity | Implement connection test as repair of existing provider configuration |
| Ollama detection | 🟡 Partially Working | CLI/app detection plus loopback API status distinguishes installed/available | Mock tests and setup API state pass | App-bundle detection/start fixed in 0.1.1 | Compare CLI/API states on current host |
| Ollama model library | 🟡 Partially Working | Catalog, installed/running list, pull/cancel/delete/load/unload/default UI | Parser/lifecycle tests pass | Setup downloads added in 0.1.1 | Real service/model operations require available Ollama instance |
| Local AI inference | 🔵 Blocked / External Requirement | Ollama `/api/chat` request path wired into AI chat | Mocked adapter tests pass | None in this phase yet | Real prompt needs running Ollama and an installed model |
| AI chat | 🟡 Partially Working | Provider/model chooser, messages, attachments, clear chat, errors | Five UI-state tests plus adapter unit tests pass | Provider/model synchronization fixed in 0.1.1 | Real backends; Markdown/code rendering audit; no streaming/stop exists |
| Workspace indexer | 🟡 Partially Working | Bounded text indexing, ranking, ignore rules, relevant-file retrieval | Unit tests pass | None in this phase yet | Real change/new/delete/rename/large/binary workflow |
| AI context controls | 🟡 Partially Working | Current/open/selected files, workspace retrieval, selection, terminal, problems, Git | Code inspection and index tests | None in this phase yet | Inspect actual composed requests with multi-file fixture |
| Inline AI edit | 🟡 Partially Working | Selected text request, generated replacement, Monaco diff, accept/reject | Backend AI and renderer wiring inspected | None in this phase yet | Real/model-backed proposal and save/undo behavior |
| Agent mode | 🟡 Partially Working | Prompt-to-proposal workflow, workspace context, command approval callback, diff review | Code inspection; diff backend tests pass | None in this phase yet | Disposable multi-file workflow and backend permission bypass audit |
| Diff review / undo | 🟡 Partially Working | File/hunk accept/reject/all/undo/discard with event updates | Seven diff-manager tests pass | None in this phase yet | UI-to-filesystem multi-file end-to-end test |
| Settings | 🟡 Partially Working | Theme/autosave/permissions in user storage; validated workspace JSON; AI settings | Settings-manager unit tests pass | None in this phase yet | Restart persistence, corrupt config, each exposed setting |
| Themes and layout | 🟡 Partially Working | Dark/light/system styles and resizable panels | Setup tested at normal and 960×600 | None in this phase yet | Contrast/state review; panel resize; layout persistence is not implemented |
| Security boundaries | 🟡 Partially Working | Sandboxed renderer, trusted IPC sender checks, workspace path authorization, sensitive-file exclusions, command allowlists | Sensitive path/filesystem/server tests and navigation smoke pass | None in this phase yet | Agent/diff/Git/terminal adversarial matrix and logging audit |
| Logging / diagnostics | 🟡 Partially Working | User-visible errors/output and bounded process details; no centralized persistent logger | Code inspection | None in this phase yet | Confirm useful categories and absence of secrets across failures |
| Performance | 🟡 Partially Working | Bounded reads/search/output and cleanup paths exist | No sustained measurements yet | None in this phase yet | Startup timing, CPU/memory, large workspace, listener/process leak checks |

## Explicitly absent capabilities

These are not failures unless existing UI or documentation claims otherwise:

- ⚪ Tauri/Rust backend
- ⚪ VS Code extension-host compatibility
- ⚪ Native debugger adapter or language-server client
- ⚪ Git merge UI and GitHub-specific API authentication
- ⚪ Streaming cloud/local chat and stop-generation control
- ⚪ Conversation persistence across restart
- ⚪ Window and panel-layout persistence
