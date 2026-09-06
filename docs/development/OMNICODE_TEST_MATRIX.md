# OmniCode Stabilization Test Matrix

Last updated: 2026-09-06

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
| Filesystem | Create file/folder | Verify nested real filesystem changes | Pass | Packaged integration | Real nested directory and Unicode file created through preload/backend |
| Filesystem | Rename file/folder | Spaces, punctuation, Unicode | Pass | Packaged integration + unit | Real file renamed; remaining context-menu UI paths pending |
| Filesystem | Move file/folder | Nested paths and invalid cycles | Pass | Packaged integration + unit | Real nested file moved; invalid cycles covered by unit test |
| Filesystem | Duplicate file/folder | Verify contents and destination | Pass | Packaged integration + unit | Real duplicate content verified on disk |
| Filesystem | Trash file/folder | Verify scoped deletion | Pass | Packaged integration + unit | Disposable file and audit directory moved to macOS Trash through OmniCode |
| Filesystem | Save | Persist editor content and clear dirty state | Pass | Packaged E2E | Monaco edit saved and exact disk bytes verified |
| Filesystem | Save As | Persist to user-selected path | Not run | Manual/E2E | Native dialog required |
| Filesystem | Autosave | Delayed write and conflict behavior | Not run | E2E | Scheduled |
| Filesystem | External changes | Reload/close/conflict behavior | Covered | Code inspection | Real E2E pending |
| Filesystem | Recent workspaces | Persist/reopen and remove missing entries | Pass | Unit + smoke | Real restart E2E pending |
| Filesystem | Outside workspace | Reject unauthorized read/write | Pass | Packaged integration + unit | `/etc/passwd` read rejected through production preload/backend |
| Filesystem | Drag/drop | File and directory authorization | Not run | Manual | Scheduled |
| Filesystem | Reveal/Open With | Finder integration | Not run | Manual | Scheduled |
| Editor | Multiple tabs | Open, switch, and close files | Not run | E2E | Scheduled |
| Editor | Languages | Map HTML/CSS/JS/TS/Python/Java/C/C++/Swift/Rust/Go/JSON/Markdown | Pass | Unit | Seven mapping/registry tests |
| Editor | Core editing | Type, selection, copy/paste, undo/redo | Partial | Packaged E2E | Select-all and real text insertion passed; clipboard and undo/redo remain |
| Editor | Find/replace | Find, replace, find-all | Partial | Packaged E2E | Cmd+F opened Monaco find; replace/find-all remain |
| Editor | Visual features | Lines, indentation, brackets, folding, minimap | Not run | Manual/E2E | Scheduled |
| Editor | Dirty state | Indicator, save, close prompt | Partial | Packaged E2E | Dirty indicator and clean-after-save passed; unsaved close prompt remains |
| Editor | Resize | Editor relayout after panel/window changes | Not run | Manual/E2E | Scheduled |
| Shortcuts | File/edit | ⌘S, ⌘O, ⌘F, ⌘W, ⌘Z, ⌘⇧Z | Partial | Packaged E2E/manual | Cmd+F passed; native menu accelerators require unlocked interactive automation/manual pass |
| Shortcuts | Navigation | ⌘P and ⌘⇧P | Not run | Manual/E2E | Scheduled |
| Shortcuts | Settings/terminal/AI | ⌘,, ⌘`, ⌃⇧`, ⌘I | Not run | Manual/E2E | Scheduled |
| Search | Workspace search | ripgrep and fallback results | Covered | Unit | Real UI pending |
| Search | Replace all | Scoped replacement | Covered | Unit | Real UI pending |
| Search | Ignore/include/exclude | `.gitignore`, `.omnicodeignore`, globs | Covered | Unit | Large real fixture pending |
| Terminal | zsh | Start real login shell | Pass | Packaged smoke | `/bin/zsh` launched |
| Terminal | Working directory | `pwd` equals workspace | Pass | Packaged integration | Real PTY printed exact authorized workspace cwd |
| Terminal | Basic commands | `ls`, `echo`, `whoami`, environment | Pass | Packaged integration | Real zsh identity and environment markers passed |
| Terminal | PATH | Intel/Apple Homebrew paths visible | Pass | Packaged integration + unit | Both standard Homebrew bin paths and real Node/Git lookup passed |
| Terminal | Interactive | Ctrl+C, history, interactive process | Partial | Packaged integration | Real sleep interrupted with Ctrl+C; history UI remains |
| Terminal | Sessions | Create/switch/close/restart/clear multiple terminals | Partial | Packaged integration | Multiple isolated sessions, restart, and kill passed; UI switch/clear remains |
| Terminal | Resize/scroll/copy/paste | xterm behavior | Partial | Packaged integration | PTY resize and xterm mount passed; scroll/clipboard remain |
| Runtime | Detection | 33 allowlisted tools return installed/missing states | Pass | Packaged integration + unit | Requested tool states matched independent host command lookup |
| Runtime | Missing tools | Clean state without crash or stack trace | Pass | Automated | Runtime tests and setup smoke |
| Runtime | Fresh Mac shims | Detection does not trigger Apple installer | Pass | Unit | Regression coverage |
| Runtime | Installation | Formula/native paths, progress, cancellation | Pass | Unit/integration-mock | No real system changes made |
| Hardware | Current Mac | Architecture/CPU/RAM/macOS/Metal correctness | Pass | Packaged integration | x64 Sonoma 14.8.9, Intel i5, 8 GiB, UHD 617, Metal 3 verified |
| Hardware | Recommendations | Memory-based model ranking | Pass | Unit | Real host comparison pending |
| Run | Python | Real success and syntax error through OmniCode | Pass | Packaged integration | `PYTHON_OK`; syntax error returned nonzero |
| Run | JavaScript | Real success and runtime error through OmniCode | Pass | Packaged integration | `NODE_OK`; thrown error returned nonzero |
| Run | C/C++ | Real compile/run and compiler error | Pass | Packaged integration | Clang and Clang++ outputs passed; invalid C returned compiler diagnostics |
| Run | Swift | Real script/compile | Pass | Packaged integration | `SWIFT_OK`; first cold invocation was slow but completed |
| Run | Java | Real compile/run | Pass | Packaged integration | javac/java produced `JAVA_OK` |
| Run | Rust | Real Cargo build/run | Blocked | Host integration | BLOCKED — USER CONFIGURATION REQUIRED: rustc/Cargo not installed |
| Run | Go | Real build/run | Blocked | Host integration | BLOCKED — USER CONFIGURATION REQUIRED: Go not installed |
| Run | Error reporting | stdout, stderr, exit code, missing tool | Pass | Packaged E2E + unit | Run UI showed stdout and `[Process exited with code 0]`; deliberate failures nonzero |
| npm | Script detection | Read package scripts and choose runner | Pass | Packaged integration + unit | Disposable manifest exposed real `npm run` commands |
| npm | Install/run/server | Real lifecycle with approval boundary | Pass | Packaged E2E | `npm run verify` and dependency-free server passed; no `node_modules` or automatic install was created |
| Server | Static start | Start valid localhost port | Pass | Packaged E2E | Auto port returned reachable HTTP server and Run UI reflected state |
| Server | Assets/nested paths | HTML/CSS/JS/relative resources | Pass | Packaged integration | Real HTML, CSS, JS, and nested file bytes served successfully |
| Server | Secret denial | Deny `.git` and `.env` | Pass | Packaged smoke | Both returned 403 |
| Server | Stop/restart/port release | Lifecycle correctness | Pass | Packaged integration + unit | Static/package restart passed, stopped ports rebound, explicit conflict was useful |
| Server | Live reload | HTML/CSS/JS browser update | Partial | Packaged integration | Injected client and real SSE reload after write passed; actual browser page refresh remains manual |
| Git | Repository detection/status | Real disposable repository | Pass | Packaged E2E + unit | UI initialized repository and reflected clean/changed/staged states |
| Git | Stage/unstage/commit/diff | Actual state matches UI | Pass | Packaged E2E | Real working diff reached Output; UI stage/unstage/commit matched disk and Git |
| Git | Init/branches | Initialize, create, switch, delete | Pass | Packaged E2E | All branch controls passed in disposable repository |
| Git | Fetch/pull/push | Report exit success/failure accurately | Pass | Packaged E2E + integration | Real local bare remote synchronized; missing-remote push rejected usefully |
| Git | Clone | HTTPS/SSH URL validation and actual clone | Pass | Real integration + unit | Manager cloned local bare remote; public GitHub HTTPS clone passed via host Git; native picker UI remains manual |
| GitHub | Authentication | Existing SSH/HTTPS/gh state | Blocked | Host inspection | `gh` absent and no safe configured writable remote; USER CONFIGURATION REQUIRED for authenticated writes |
| Keychain | Save/read/restart | All provider keys across manager instances | Pass | Native + packaged E2E | Isolated native test passed all providers; packaged temporary OpenAI key survived a full app restart and was actually used; user Google key untouched |
| Keychain | Update/remove | Replace and delete all provider keys | Pass | Native integration | Disposable keychain |
| Keychain | Secret leakage | Source/log/config/Git scan | Partial | Automated/code | Full runtime log scan pending |
| OpenAI | Request adapter | Auth header, payload, response/errors | Pass | Unit | Mock server/fetch |
| OpenAI | Invalid credential | Stored key is used and an accurate redacted auth error reaches UI | Pass | Packaged E2E | Temporary audit key survived restart, produced authentication failure, never appeared in returned error, and was deleted |
| OpenAI | Real minimal successful request | Response reaches UI | Blocked | Manual/E2E | BLOCKED — USER CONFIGURATION REQUIRED; no valid OpenAI key is configured |
| Claude | Request adapter | Auth headers, payload, response/errors | Pass | Unit | Mock server/fetch |
| Claude | Real minimal request | Response reaches UI | Blocked | Manual/E2E | USER CONFIGURATION REQUIRED if no key |
| Gemini | Request adapter | Auth header, payload, response/errors | Pass | Unit | Mock server/fetch |
| Gemini | Real minimal request | Exact response reaches packaged app | Pass | Packaged E2E | Existing Keychain credential authenticated; exact `OmniCode Cloud AI Test Successful` response received; no renderer errors |
| Providers | Connection endpoints | Lightweight official endpoint, headers, auth/rate/network states | Pass | Unit | OpenAI, Anthropic, and Google request shapes and state mapping covered |
| Providers | Status UI | Stored vs authenticated/connected | Pass | Packaged E2E | Stored/not-tested after restart, Connected for valid Gemini, Authentication failed for invalid OpenAI; Save/Test/Delete exercised |
| Ollama | Installed/service states | Distinguish absent, stopped, available | Pass | Unit + packaged E2E | CLI/app absent and port 11434 closed on host; packaged API/UI accurately reported not installed; stopped/available branches unit-covered |
| Ollama | Missing-service chat error | Fail accurately without a fake response or raw stack | Pass | Packaged E2E + unit | Rebuilt app reports installation guidance; installed-but-stopped and HTTP/model error variants covered |
| Ollama | Model list | Real installed/running models | Blocked | Integration | Ollama service required |
| Ollama | Pull/cancel/delete/default | Real small-model lifecycle | Blocked | E2E | Ollama service/model required |
| Ollama | Real inference | Exact response and coding question | Blocked | E2E | Ollama service/model required |
| AI chat | Provider/model switching | Defaults and manual changes stay coherent | Pass | Renderer unit | Five regression tests |
| AI chat | Conversation clear/errors | UI resets and surfaces failure | Partial | Unit/inspection | Real provider pending |
| AI chat | Markdown/code blocks | Render assistant response appropriately | Not run | E2E | Current implementation uses preformatted text |
| AI chat | Streaming/stop | Generation updates and cancellation | Not implemented | Inspection | No UI/backend support exists |
| Context | Current/open/selected files | Inspect exact outbound request | Not run | Integration | Scheduled |
| Context | Workspace retrieval | Multi-file relevance and actual payload | Pass | Unit + packaged live E2E | Exact outbound system context inspected in unit test; real Gemini derived undisclosed TTL/table/prefix across five retrieved files after consent |
| Context | Terminal/problems/Git | Include only explicitly selected data | Not run | Integration | Scheduled |
| Indexer | Initial/changed/new/deleted/renamed | Maintain current index | Pass | Unit + packaged E2E | Watcher-driven update/create/rename/delete refresh passed; stale tokens and paths disappeared |
| Indexer | Ignore/binary/large | Exclude sensitive/binary/huge files | Pass | Unit | Large-project performance pending |
| Inline AI | Proposal/accept/reject/save | Real selected-code workflow | Blocked | E2E | Working AI backend required |
| Agent | Inspect/plan/propose files | Disposable multi-file task | Pass | Packaged live E2E | Two transient 503 attempts stopped safely with no writes; later retry read multiple files, proposed one derived file, opened review, accepted, and undid it |
| Agent | Plan parsing/path safety | Reject traversal, malformed, incomplete, and oversized plans | Pass | Unit | Relative paths only; 50-file, 20-step, and 10-command limits verified |
| Agent | Command permission | Approval and backend enforcement | Partial | Unit + packaged security | Main process blocked `sudo` and wrong workspace; dangerous command matrix passes; allowed-command native confirmation acceptance remains manual |
| Diff | File/hunk accept/reject/all | Filesystem matches decisions | Pass | Unit + packaged E2E | Real three-file transaction stayed staged until accept; reject preserved disk |
| Diff | Create/delete/undo | Restore exact filesystem state | Pass | Unit + packaged E2E | Modify/create/delete acceptance and full snapshot undo matched disk |
| Settings | Workspace JSON | Validate/read/write and corrupt input | Pass | Unit | UI/restart pending |
| Settings | User preferences | Theme/autosave/permission restart | Partial | Packaged E2E | Settings opens from workbench; persistence controls remain |
| Settings | AI model/default | Persist selected/default local model | Covered | Unit | Real restart pending |
| Themes | Dark/light/system | Contrast and component states | Not run | Visual/manual | Scheduled |
| Layout | Resizing | Sidebars/panel/window min/max | Partial | Setup smoke | Workbench panels pending |
| Layout | Persistence | Restore panel dimensions | Not implemented | Inspection | No persistence code found |
| Security | Renderer sandbox/IPC sender | Reject untrusted calls/navigation | Pass | Automated/smoke | Further adversarial tests pending |
| Security | Workspace boundary | Reject arbitrary external paths | Pass | Unit | Agent/terminal special cases pending |
| Security | Dangerous commands | Backend approval enforcement | Partial | Unit + packaged security | Main-process policy blocks privileged/destructive/Keychain/nested-shell patterns; native approval acceptance remains manual |
| Failure | Offline/provider/rate-limit/timeout | Graceful accurate errors | Partial | Unit + packaged E2E | Auth failure and a real transient Gemini 503 surfaced honestly; offline and timeout E2E remain |
| Failure | Permission/read-only/moved files | Graceful accurate errors | Partial | Unit | Real filesystem E2E pending |
| Performance | Startup/idle | Time, CPU, memory | Not run | Measurement | Scheduled |
| Performance | Large workspace/index/search | Responsiveness and bounds | Not run | Measurement | Scheduled |
| Performance | Cleanup/leaks | Listeners, PTYs, servers, AI operations | Not run | Soak | Scheduled |
| Production | Build | Typecheck and electron-vite build | Pass | Automated | Baseline 0.1.1 |
| Production | Intel app | Launch and core smoke on Sonoma | Pass | Automated smoke | Current host x86_64 |
| Production | Apple Silicon app | Correct executable/native slices | Pass | Automated inspection | Hardware launch blocked |
| Production | Archives | DMG/ZIP integrity and checksums | Pass | Automated | 0.1.1 baseline |
| Production | Signing/notarization | Gatekeeper-ready public release | Blocked | External | Developer ID certificate required |
