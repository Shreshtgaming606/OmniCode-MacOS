# OmniCode Release Readiness

Last updated: 2026-09-22

## Overall Status

**NOT READY for a signed public release.**

OmniCode 0.6.0 is the current verified unsigned release candidate for Intel
macOS Sonoma, with a separately built and structurally verified Apple Silicon
installer that still requires matching-hardware runtime execution.
The separate Work Mode, Code Mode regression surface, real terminal, filesystem,
Git, local server, provider adapters, Google OAuth boundary, Gmail/Drive tools,
opaque cross-service transfers, persisted connector result cards, and the new
Work action approval system, real Code Agent tools, Glasses Mode, and the new
provider-neutral Agent Plan/Reasoning Summary layer are covered without a
tracked failing test. The 0.5.1 Intel package passed a controlled five-turn
local-model audit of initial/changed/progress plans, current/next state,
assumptions, decisions, Skip Step, Modify Plan, stale-call cancellation,
pause/resume, real runtime detection, Standard/Glasses filtering, final
reporting, layout, and renderer errors. The earlier 0.5.0 package passed
startup, workspace, real PTY, localhost/security, live Gemini Code Agent,
persistent Glasses timeline, and diff-action audits; the 0.4.0 Work action
audit and earlier lifecycle soak remain valid for unchanged systems. Both Intel
and Apple Silicon 0.5.1
distributions pass archive, disk-image, version, architecture, native-terminal,
original-icon, and SHA-256 validation. The new 0.6.0 x64 and arm64 DMG/ZIP
artifacts likewise pass image/archive integrity, embedded-version, icon,
application/helper/native-terminal architecture, and checksum verification.
The x64 0.6.0 package also passed the core release smoke with zero renderer
errors.

The current production-rendered Omni surface also passes a disposable
fresh-profile audit of its seven-step setup, central voice-first dashboard,
real provider/model/execution/approval controls, default-off typed fallback,
Settings persistence, 960×600 and 720×720 responsive layouts, Reduce Motion,
and zero renderer errors. This improves UI/setup readiness but does not clear
the separate signing, Speech-asset, provider-availability, local-wake, or Apple
Silicon execution gates below.

Public release is still blocked by Apple signing/notarization, matching-hardware
Apple Silicon execution, and external service/account gates. In particular, the
current 0.5.1 internal-test installers contain the publisher's Testing Desktop
OAuth metadata in the trusted main process. Real consent, shared Gmail/Drive
identity, restart persistence, and minimal read-only API calls passed with an
approved test account. This Testing client is not a substitute for Google's
production verification and is not available to arbitrary public users. A
Gemini API key cannot authorize Google Workspace.

The matrix result is **217 of 238 tracked behaviors passing (91.2%)**. Fifteen
are externally blocked, three are accurately not implemented or claimed, and
three are partially exercised. No blocked, partial, or absent capability is
counted as passing.

## Test Summary

| Result | Count | Meaning |
| --- | ---: | --- |
| Tests passed | 217 | Observed behavior met the stated expectation |
| Tests failed | 0 | No currently tracked test has a known failing result |
| Tests blocked | 15 | External credential, service, hardware, runtime, repository, safe test data, native platform bridge, or certificate required |
| Tests not run / not implemented | 3 | Code Chat streaming/stop, rich-document attachment extraction, and layout persistence are absent and not presented as complete |
| Tests partially run | 3 | Gmail mutations, Drive mutations, and physical network disconnection were not performed; their safe/controlled paths are covered |

Automated regression result: **571 passed, 1 intentionally skipped, 0 failed**
across 67 test files (66 passing and one skipped). The skipped test is native Keychain integration inside the
ordinary suite; that behavior was run separately with disposable credentials and
passed. TypeScript checking and x64/arm64 production builds also pass. A final
credential scan covered 238 repository files, 30 isolated-profile files, the
empty disposable plan workspace, renderer storage, and diagnostics without
finding credential material outside Keychain or the trusted OAuth build boundary.

## Subsystems

| Subsystem | Readiness | Evidence / limitation |
| --- | --- | --- |
| Editor | ✅ Ready | Real multi-tab editing, Monaco behavior, shortcuts, save/autosave/conflicts, and dirty-close flows passed |
| Filesystem | ✅ Ready | Real create/open/rename/move/duplicate/trash/drag/drop/native-dialog operations matched disk and workspace boundaries |
| Terminal | ✅ Ready | Real zsh PTY, cwd, environment, Homebrew-aware PATH, interaction, sessions, resize, clipboard, and cleanup passed |
| Run / Compile | 🟡 Ready for installed tools | Python, Node, C, C++, Swift, Java, npm, custom pipelines, failures, stdout/stderr, and exit code passed; Rust/Go are unavailable on this host |
| Local Server | ✅ Ready | Static and npm servers, assets, live reload, browser update, conflicts, restart/stop, and port release passed |
| Git | ✅ Ready | Init/status/diff/stage/unstage/commit/branch/clone/fetch/pull/push passed with real disposable repositories |
| GitHub | 🔵 Blocked for authenticated writes | Public HTTPS clone passed; safe authenticated HTTPS/SSH write credentials and repository were unavailable |
| Ollama | 🔵 Blocked for real model lifecycle | Absent/stopped/available handling is covered and host absence is accurate; service/model required for live list/pull/delete/inference |
| OpenAI | 🔵 Blocked for successful live response | Adapter plus stored-invalid-key/redacted-auth path passed; valid account credential required |
| Claude | 🔵 Blocked for successful live response | Adapter request/error behavior passed; valid account credential required |
| Gemini | ✅ Ready for tested API-key behavior | Keychain retrieval, connection test, Code/Work responses, streaming, Markdown, context, and Agent workflows completed in prior live verification |
| AI Chat | ✅ Ready for implemented behavior | Provider/model selection, messages, Markdown/code, context, clear, and honest errors passed; Code Chat does not claim Work Mode's streaming/Stop/history |
| Work Mode | ✅ Core ready | Separate mounted surface, persistent conversations, grouped history/search/pin, streaming/Stop, Copy/Edit/Regenerate, text attachments, and packaged responsive smokes passed |
| Workspace Indexer | ✅ Ready | Watcher freshness, ranking, ignores, binary/sensitive exclusions, and a responsive 1,203-file workload passed |
| Code Agent / Glasses | ✅ Ready for implemented tool workflow | Shared provider-native tool loop; real workspace/diff, PTY/build/test, Git, server, runtime, Managed Code Browser, external-grant and app-launch tools; independent approval/visibility/focus; visible provider-neutral plans and concise reasoning summaries; pause/resume/Take Over/Modify Plan/Skip Step/stop; private redacted history. A packaged local five-turn audit proved dynamic course changes, stale-call cancellation, Standard/Glasses, and final reporting with zero errors; the earlier Gemini write/read/diff task remains valid |
| Work Agent / Tools | ✅ Ready for registered tools | Bounded provider-native tool loop, schemas, mode/risk enforcement, hard boundaries, cancellation, redaction, local-model gate, and prompt-injection resistance pass for OpenAI, Claude, Gemini, and compatible Ollama paths |
| Work Action Approvals | ✅ Ready | Global Ask/Approve-for-me/Full modes, per-connector overrides, backend-only policy, dynamic critical escalation, first-use Full warning, exact action cards/native fallback, and private activity pass automated and packaged live tests |
| Connected Apps | 🟡 Registered connectors operational | Managed Browser passed live; real shared Google consent, identity, restart persistence, Gmail/Drive reads, permission modes, and exact cancelled Gmail-send approval passed. Full live Google mutations/transfers still need disposable data and confirmation |
| Gmail | 🟡 Read path live; mutations controlled-only | Real packaged label listing passed. Search/read/thread/attachment/draft/send/reply/state/archive tools and exact send confirmation pass controlled tests; content-bearing live reads and writes were deliberately not performed |
| Google Drive | 🟡 Read path live; mutations controlled-only | Real packaged Drive search passed. List/read/export/download/save/upload/organize/trash/restore paths pass controlled tests; live content reads and writes were deliberately not performed |
| Google Workspace transfers | ✅ Ready at the trusted boundary | Gmail attachment→Drive and Drive file→Gmail draft preserved exact bytes through opaque expiring capabilities without model-visible base64 or paths |
| Connector result cards | ✅ Ready | Bounded Gmail/Drive previews persist and render in dark and compact-light packaged runs without internal IDs, raw bodies, bytes, paths, or renderer errors |
| Diff System | ✅ Ready | Modify/create/delete staging, accept/reject, filesystem match, undo, and traversal denial passed |
| Settings | ✅ Ready | User/workspace persistence, corrupt-input handling, `0600` storage, Work/Connected Apps actions, global/per-connector approval modes, Full warning, and model dropdowns passed |
| Keychain | ✅ Ready | Save/read/restart/update/delete passed with disposable credentials; leak scans found no credential outside Keychain |
| macOS Integration | 🟡 Partially ready | Menus, dialogs, shortcuts, Finder, window lifecycle, themes, and file associations passed; notifications/public trust require signing |
| Production Build | 🟡 Unsigned release candidate | Four 0.5.1 artifacts pass DMG/ZIP integrity, version, original icon, executable/native-module architecture and checksum validation; x64 passed the packaged plan/intervention audit, while arm64 launch plus Apple signing/notarization remain blocked |

## Release Artifacts

| Target | Artifact | Size | SHA-256 |
| --- | --- | ---: | --- |
| Apple Silicon installer | `dist/OmniCode-0.5.1-arm64.dmg` | 143,558,505 bytes | `cb4d39fc5a1e8ace55da897df8b813ada6309613b53e313f5a13449b0a6bef0a` |
| Apple Silicon archive | `dist/OmniCode-0.5.1-arm64.zip` | 141,557,923 bytes | `39ceb50c51675ad2f1a58b6bfcec030b71f74c87825ba3de23c93653eee6a2ac` |
| Intel installer | `dist/OmniCode-0.5.1-x64.dmg` | 147,223,946 bytes | `cf84008320dda39e5c307b9833dcf0a5adb3db577671529b088b4e7b990ef52e` |
| Intel archive | `dist/OmniCode-0.5.1-x64.zip` | 145,274,084 bytes | `b3c56d812244d0a6e2104ae5c6ac572c9eb4195faf6ecbd8d4834f0ff67c1358` |

Checksums are recorded in `dist/SHA256SUMS.txt` and the release-specific
`dist/SHA256SUMS-0.5.1.txt`.

## Remaining Problems

1. **Apple signing/notarization:** a Developer ID Application certificate and
   notarization credentials are required. Gatekeeper trust and Notification
   Center delivery are not public-release-ready until this is completed.
2. **Apple Silicon execution:** the 0.5.1 arm64 executable and packaged `node-pty`
   module are arm64 and its archives pass, but launch/smoke must run on a matching
   Apple Silicon Mac.
3. **Google public-production approval and full live service workflows:** the
   Testing client passed real consent and read-only Gmail/Drive probes for an
   approved tester. Public distribution still requires the verified production
   project/client and any required Restricted Scope security assessment. Live
   Gmail/Drive mutations and cross-service transfers still require disposable
   test data and exact confirmations.
4. **OpenAI and Claude live success:** valid credentials/account access are not
   configured. Adapter, Keychain, invalid-auth, redaction, and error paths pass.
5. **Ollama model lifecycle/inference:** Ollama and a local model are absent on
   this host. Absence and failure states are verified without fake success.
6. **Authenticated GitHub writes:** a safe writable remote and credentials are
   required for real HTTPS/SSH authentication checks.
7. **Missing host runtimes:** Rust/Cargo and Go are absent. Setup offers guarded
   installation and honest failure/cancel states; unattended success remains
   affected by the host's Homebrew ownership condition.
8. **Inline AI model-backed edit:** selection/shortcut/request wiring exists,
   but full proposal/accept/reject/save E2E remains blocked by the unavailable
   configured local backend.
9. **Physically disconnected-network E2E:** transport/rate/timeout mappings and
   real provider failures are covered; the host network was not disabled because
   that would disrupt this development session.
10. **Rich Work attachments:** bounded text/source files pass; PDF, Word,
    spreadsheet, and image extraction is explicitly unsupported in this build.
11. **Code Chat streaming/persistence:** Work Mode implements and verifies these;
    the older Code Chat remains final-response-only and nonpersistent and does not
    claim otherwise.
12. **Arbitrary external-app UI control:** allowlisted app launch and permission
    state/reporting pass, but external-app observation/click/type requires a
    separately audited native macOS Accessibility bridge. OmniCode blocks
    unrestricted AppleScript and screen-capture substitutes and reports the
    structured controller as not implemented.

## Conclusion

OmniCode 0.5.1 is ready for controlled Intel macOS Sonoma testing as an unsigned
release candidate, with statically verified Apple Silicon installers. It is not
ready to be labeled a signed, notarized public macOS release until the external
Apple, matching-hardware, Google-production-review, and configured-service gates
above are completed.
