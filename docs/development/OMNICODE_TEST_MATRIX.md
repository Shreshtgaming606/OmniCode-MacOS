# OmniCode Stabilization Test Matrix

Last updated: 2026-09-05

Results are changed to **Pass** only after the recorded behavior was observed.
“Covered” means an existing automated test exercises the code path; it does not
substitute for a real integration test where one is required.

| System | Feature | Test | Result | Automated/Manual | Notes |
| --- | --- | --- | --- | --- | --- |
| Startup | Fresh profile | Launch packaged app into setup | Pass | Automated smoke | Intel Sonoma; no renderer exceptions |
| Startup | Workbench | Complete setup and render main window | Pass | Automated smoke | No white/infinite loading state |
| Startup | Window lifecycle | Minimize, zoom/full-screen, close, reopen | Not run | Manual | Scheduled |
| Startup | Menu | Open each native menu and invoke core commands | Not run | Manual/E2E | Scheduled |
| Startup | Console | Capture renderer/unhandled startup errors | Pass | Automated smoke | No meaningful errors captured |
| Filesystem | Open folder | Authorize and display real temporary workspace | Pass | Automated smoke | Tree returned two entries |
| Filesystem | Open file | Open real file from cold launch | Pass | Automated smoke | Offline Monaco loaded |
| Filesystem | Create file/folder | Verify nested real filesystem changes | Covered | Unit | UI E2E pending |
| Filesystem | Rename file/folder | Spaces, punctuation, Unicode | Covered | Unit | UI E2E pending |
| Filesystem | Move file/folder | Nested paths and invalid cycles | Covered | Unit | UI E2E pending |
| Filesystem | Duplicate file/folder | Verify contents and destination | Covered | Unit | UI E2E pending |
| Filesystem | Trash file/folder | Verify scoped deletion | Covered | Unit | Manual Finder/Trash check pending |
| Filesystem | Save | Persist editor content and clear dirty state | Not run | E2E | Scheduled |
| Filesystem | Save As | Persist to user-selected path | Not run | Manual/E2E | Native dialog required |
| Filesystem | Autosave | Delayed write and conflict behavior | Not run | E2E | Scheduled |
| Filesystem | External changes | Reload/close/conflict behavior | Covered | Code inspection | Real E2E pending |
| Filesystem | Recent workspaces | Persist/reopen and remove missing entries | Pass | Unit + smoke | Real restart E2E pending |
| Filesystem | Outside workspace | Reject unauthorized read/write | Pass | Automated | Filesystem boundary tests |
| Filesystem | Drag/drop | File and directory authorization | Not run | Manual | Scheduled |
| Filesystem | Reveal/Open With | Finder integration | Not run | Manual | Scheduled |
| Editor | Multiple tabs | Open, switch, and close files | Not run | E2E | Scheduled |
| Editor | Languages | Map HTML/CSS/JS/TS/Python/Java/C/C++/Swift/Rust/Go/JSON/Markdown | Pass | Unit | Seven mapping/registry tests |
| Editor | Core editing | Type, selection, copy/paste, undo/redo | Not run | E2E | Scheduled |
| Editor | Find/replace | Find, replace, find-all | Not run | E2E | Scheduled |
| Editor | Visual features | Lines, indentation, brackets, folding, minimap | Not run | Manual/E2E | Scheduled |
| Editor | Dirty state | Indicator, save, close prompt | Not run | E2E | Scheduled |
| Editor | Resize | Editor relayout after panel/window changes | Not run | Manual/E2E | Scheduled |
| Shortcuts | File/edit | ⌘S, ⌘O, ⌘F, ⌘W, ⌘Z, ⌘⇧Z | Not run | Manual/E2E | Scheduled |
| Shortcuts | Navigation | ⌘P and ⌘⇧P | Not run | Manual/E2E | Scheduled |
| Shortcuts | Settings/terminal/AI | ⌘,, ⌘`, ⌃⇧`, ⌘I | Not run | Manual/E2E | Scheduled |
| Search | Workspace search | ripgrep and fallback results | Covered | Unit | Real UI pending |
| Search | Replace all | Scoped replacement | Covered | Unit | Real UI pending |
| Search | Ignore/include/exclude | `.gitignore`, `.omnicodeignore`, globs | Covered | Unit | Large real fixture pending |
| Terminal | zsh | Start real login shell | Pass | Packaged smoke | `/bin/zsh` launched |
| Terminal | Working directory | `pwd` equals workspace | Not run | Integration | Smoke uses workspace cwd but does not assert `pwd` output |
| Terminal | Basic commands | `ls`, `echo`, `whoami`, environment | Partial | Packaged smoke | One `printf` command passed |
| Terminal | PATH | Intel/Apple Homebrew paths visible | Covered | Unit | Real PTY assertion pending |
| Terminal | Interactive | Ctrl+C, history, interactive process | Not run | E2E | Scheduled |
| Terminal | Sessions | Create/switch/close/restart/clear multiple terminals | Not run | E2E | Scheduled |
| Terminal | Resize/scroll/copy/paste | xterm behavior | Not run | E2E | Scheduled |
| Runtime | Detection | 33 allowlisted tools return installed/missing states | Pass | Packaged smoke | Individual host comparison pending |
| Runtime | Missing tools | Clean state without crash or stack trace | Pass | Automated | Runtime tests and setup smoke |
| Runtime | Fresh Mac shims | Detection does not trigger Apple installer | Pass | Unit | Regression coverage |
| Runtime | Installation | Formula/native paths, progress, cancellation | Pass | Unit/integration-mock | No real system changes made |
| Hardware | Current Mac | Architecture/CPU/RAM/macOS/Metal correctness | Not run | Integration | Scheduled |
| Hardware | Recommendations | Memory-based model ranking | Pass | Unit | Real host comparison pending |
| Run | Python | Real success and syntax error through OmniCode | Not run | E2E | Depends on detected Python |
| Run | JavaScript | Real success and runtime error through OmniCode | Not run | E2E | Depends on Node |
| Run | C/C++ | Real compile/run and compiler error | Not run | E2E | Depends on Clang/Clang++ |
| Run | Swift | Real script/compile | Not run | E2E | Depends on Swift |
| Run | Java | Real compile/run | Not run | E2E | Conditional on JDK |
| Run | Rust | Real Cargo build/run | Not run | E2E | Conditional on Rust |
| Run | Go | Real build/run | Not run | E2E | Conditional on Go |
| Run | Error reporting | stdout, stderr, exit code, missing tool | Covered | Unit | Real workbench output pending |
| npm | Script detection | Read package scripts and choose runner | Covered | Unit/code | Real fixture pending |
| npm | Install/run/server | Real lifecycle with approval boundary | Not run | E2E | Scheduled |
| Server | Static start | Start valid localhost port | Pass | Packaged smoke | HTTP README returned 200 |
| Server | Assets/nested paths | HTML/CSS/JS/relative resources | Not run | Integration | Scheduled |
| Server | Secret denial | Deny `.git` and `.env` | Pass | Packaged smoke | Both returned 403 |
| Server | Stop/restart/port release | Lifecycle correctness | Partial | Smoke/unit | Explicit port release/conflict pending |
| Server | Live reload | HTML/CSS/JS browser update | Not run | E2E | Scheduled |
| Git | Repository detection/status | Real disposable repository | Covered | Unit | Real integration pending |
| Git | Stage/unstage/commit/diff | Actual state matches UI | Covered | Unit | Real integration pending |
| Git | Init/branches | Initialize, create, switch, delete | Covered | Unit | Real integration pending |
| Git | Fetch/pull/push | Report exit success/failure accurately | Covered | Unit | Authenticated remote pending |
| Git | Clone | HTTPS/SSH URL validation and actual clone | Covered | Unit | Safe remote integration pending |
| GitHub | Authentication | Existing SSH/HTTPS/gh state | Blocked | Manual | Requires configured credentials and safe repo |
| Keychain | Save/read/restart | All provider keys across manager instances | Pass | Native integration | Disposable keychain; user keys untouched |
| Keychain | Update/remove | Replace and delete all provider keys | Pass | Native integration | Disposable keychain |
| Keychain | Secret leakage | Source/log/config/Git scan | Partial | Automated/code | Full runtime log scan pending |
| OpenAI | Request adapter | Auth header, payload, response/errors | Pass | Unit | Mock server/fetch |
| OpenAI | Real minimal request | Response reaches UI | Blocked | Manual/E2E | USER CONFIGURATION REQUIRED if no key |
| Claude | Request adapter | Auth headers, payload, response/errors | Pass | Unit | Mock server/fetch |
| Claude | Real minimal request | Response reaches UI | Blocked | Manual/E2E | USER CONFIGURATION REQUIRED if no key |
| Gemini | Request adapter | Auth header, payload, response/errors | Pass | Unit | Mock server/fetch |
| Gemini | Real minimal request | Response reaches UI | Blocked | Manual/E2E | USER CONFIGURATION REQUIRED if no key |
| Providers | Status UI | Stored vs authenticated/connected | Fail | Inspection | No connection test currently exists |
| Ollama | Installed/service states | Distinguish absent, stopped, available | Covered | Unit | Current-host comparison pending |
| Ollama | Model list | Real installed/running models | Blocked | Integration | Ollama service required |
| Ollama | Pull/cancel/delete/default | Real small-model lifecycle | Blocked | E2E | Ollama service/model required |
| Ollama | Real inference | Exact response and coding question | Blocked | E2E | Ollama service/model required |
| AI chat | Provider/model switching | Defaults and manual changes stay coherent | Pass | Renderer unit | Five regression tests |
| AI chat | Conversation clear/errors | UI resets and surfaces failure | Partial | Unit/inspection | Real provider pending |
| AI chat | Markdown/code blocks | Render assistant response appropriately | Not run | E2E | Current implementation uses preformatted text |
| AI chat | Streaming/stop | Generation updates and cancellation | Not implemented | Inspection | No UI/backend support exists |
| Context | Current/open/selected files | Inspect exact outbound request | Not run | Integration | Scheduled |
| Context | Workspace retrieval | Multi-file relevance and actual payload | Covered | Unit | Real fixture E2E pending |
| Context | Terminal/problems/Git | Include only explicitly selected data | Not run | Integration | Scheduled |
| Indexer | Initial/changed/new/deleted/renamed | Maintain current index | Partial | Unit | Change lifecycle pending |
| Indexer | Ignore/binary/large | Exclude sensitive/binary/huge files | Pass | Unit | Large-project performance pending |
| Inline AI | Proposal/accept/reject/save | Real selected-code workflow | Blocked | E2E | Working AI backend required |
| Agent | Inspect/plan/propose files | Disposable multi-file task | Blocked | E2E | Working AI backend required |
| Agent | Command permission | Approval and backend enforcement | Not run | Security integration | Scheduled with simulated requests |
| Diff | File/hunk accept/reject/all | Filesystem matches decisions | Pass | Unit | Renderer E2E pending |
| Diff | Create/delete/undo | Restore exact filesystem state | Pass | Unit | Renderer E2E pending |
| Settings | Workspace JSON | Validate/read/write and corrupt input | Pass | Unit | UI/restart pending |
| Settings | User preferences | Theme/autosave/permission restart | Not run | E2E | Scheduled |
| Settings | AI model/default | Persist selected/default local model | Covered | Unit | Real restart pending |
| Themes | Dark/light/system | Contrast and component states | Not run | Visual/manual | Scheduled |
| Layout | Resizing | Sidebars/panel/window min/max | Partial | Setup smoke | Workbench panels pending |
| Layout | Persistence | Restore panel dimensions | Not implemented | Inspection | No persistence code found |
| Security | Renderer sandbox/IPC sender | Reject untrusted calls/navigation | Pass | Automated/smoke | Further adversarial tests pending |
| Security | Workspace boundary | Reject arbitrary external paths | Pass | Unit | Agent/terminal special cases pending |
| Security | Dangerous commands | Backend approval enforcement | Not run | Security integration | Scheduled |
| Failure | Offline/provider/rate-limit/timeout | Graceful accurate errors | Partial | Unit | Real network scenarios pending |
| Failure | Permission/read-only/moved files | Graceful accurate errors | Partial | Unit | Real filesystem E2E pending |
| Performance | Startup/idle | Time, CPU, memory | Not run | Measurement | Scheduled |
| Performance | Large workspace/index/search | Responsiveness and bounds | Not run | Measurement | Scheduled |
| Performance | Cleanup/leaks | Listeners, PTYs, servers, AI operations | Not run | Soak | Scheduled |
| Production | Build | Typecheck and electron-vite build | Pass | Automated | Baseline 0.1.1 |
| Production | Intel app | Launch and core smoke on Sonoma | Pass | Automated smoke | Current host x86_64 |
| Production | Apple Silicon app | Correct executable/native slices | Pass | Automated inspection | Hardware launch blocked |
| Production | Archives | DMG/ZIP integrity and checksums | Pass | Automated | 0.1.1 baseline |
| Production | Signing/notarization | Gatekeeper-ready public release | Blocked | External | Developer ID certificate required |

