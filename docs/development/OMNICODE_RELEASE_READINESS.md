# OmniCode Release Readiness

Last updated: 2026-09-13

## Overall Status

**NOT READY for a signed public release.**

OmniCode 0.3.0 is a verified unsigned release candidate for Intel macOS Sonoma.
The separate Work Mode, Code Mode regression surface, real terminal, filesystem,
Git, local server, provider adapters, Google OAuth boundary, Gmail/Drive tools,
opaque cross-service transfers, and persisted connector result cards are covered
without a tracked failing test. The Intel package passed real packaged smokes and
a three-launch soak. Both Intel and Apple Silicon distributions pass archive,
mounted-image, version, architecture, native-terminal, original-icon, and SHA-256
validation.

Public release is still blocked by Apple signing/notarization, matching-hardware
Apple Silicon execution, and external service/account gates. In particular, the
current 0.3.0 installers intentionally contain no publisher-issued Google desktop
OAuth client, so Gmail and Drive remain honestly disconnected. A Gemini API key
cannot authorize Google Workspace.

The matrix result is **152 of 173 tracked behaviors passing (87.9%)**. Seventeen
are externally blocked, three are accurately not implemented or claimed, and one
is partially exercised. No blocked or absent capability is counted as passing.

## Test Summary

| Result | Count | Meaning |
| --- | ---: | --- |
| Tests passed | 152 | Observed behavior met the stated expectation |
| Tests failed | 0 | No currently tracked test has a known failing result |
| Tests blocked | 17 | External credential, OAuth client, service, hardware, runtime, repository, or certificate required |
| Tests not run / not implemented | 3 | Code Chat streaming/stop, rich-document attachment extraction, and layout persistence are absent and not presented as complete |
| Tests partially run | 1 | Network/error mapping is covered, but physically disconnecting the host network was not performed |

Automated regression result: **395 passed, 1 intentionally skipped, 0 failed**
across 47 test files. The skipped test is native Keychain integration inside the
ordinary suite; that behavior was run separately with disposable credentials and
passed. TypeScript checking and x64/arm64 production builds also pass.

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
| AI Agent | ✅ Ready for implemented proposal workflow | Multi-file planning, staged review, accept/undo, safe command suggestion, native approval, and PTY execution passed |
| Work Agent / Tools | ✅ Ready for registered tools | Bounded provider-native tool loop, schemas, permissions, redaction, cancellation, local-model gate, and browser tool turn passed |
| Connected Apps | 🟡 Browser live; Google account test blocked | Managed Browser passed live; Google OAuth protocol and 13 Gmail/15 Drive tools pass controlled integration, but publisher client/consent/live service tests are blocked |
| Gmail | 🔵 Live verification blocked | Search/read/thread/attachment/label/draft/send/reply/state/archive tools and exact send confirmation pass controlled tests; live mailbox requires OAuth setup |
| Google Drive | 🔵 Live verification blocked | Search/list/read/export/download/save/upload/organize/trash/restore tools pass controlled tests; live Drive requires OAuth setup |
| Google Workspace transfers | ✅ Ready at the trusted boundary | Gmail attachment→Drive and Drive file→Gmail draft preserved exact bytes through opaque expiring capabilities without model-visible base64 or paths |
| Connector result cards | ✅ Ready | Bounded Gmail/Drive previews persist and render in dark and compact-light packaged runs without internal IDs, raw bodies, bytes, paths, or renderer errors |
| Diff System | ✅ Ready | Modify/create/delete staging, accept/reject, filesystem match, undo, and traversal denial passed |
| Settings | ✅ Ready | User/workspace persistence, corrupt-input handling, `0600` mode, Work/Connected Apps actions, and model dropdowns passed |
| Keychain | ✅ Ready | Save/read/restart/update/delete passed with disposable credentials; leak scans found no credential outside Keychain |
| macOS Integration | 🟡 Partially ready | Menus, dialogs, shortcuts, Finder, window lifecycle, themes, and file associations passed; notifications/public trust require signing |
| Production Build | 🟡 Unsigned release candidate | Four 0.3.0 artifacts pass integrity/static validation and x64 packaged runtime tests; arm64 launch plus Apple signing/notarization remain blocked |

## Release Artifacts

| Target | Artifact | Size | SHA-256 |
| --- | --- | ---: | --- |
| Apple Silicon installer | `dist/OmniCode-0.3.0-arm64.dmg` | 143,539,257 bytes | `5fc4e9f96e7e13d97f3ad5f28bff3c60be46577d84b1c39d3f8b0010ee0b3890` |
| Apple Silicon archive | `dist/OmniCode-0.3.0-arm64.zip` | 141,520,936 bytes | `854bae355108853f9e7832461721f18a4dbd99faab1aae4d63167c9e58f91361` |
| Intel installer | `dist/OmniCode-0.3.0-x64.dmg` | 147,189,913 bytes | `d36d4cbf71b21e7a9c64ffe20225cb9b3d9ca73f8b718c83737dc10ba93fdf6b` |
| Intel archive | `dist/OmniCode-0.3.0-x64.zip` | 145,237,053 bytes | `e720dc93e1ba3bdae426e90cc3847fdacd7178f60985de4654ab8f818dac00ad` |

Checksums are recorded in `dist/SHA256SUMS.txt` and the release-specific
`dist/SHA256SUMS-0.3.0.txt`.

## Remaining Problems

1. **Apple signing/notarization:** a Developer ID Application certificate and
   notarization credentials are required. Gatekeeper trust and Notification
   Center delivery are not public-release-ready until this is completed.
2. **Apple Silicon execution:** the 0.3.0 arm64 executable and active `node-pty`
   module are arm64 and its archives pass, but launch/smoke must run on a matching
   Apple Silicon Mac.
3. **Google Workspace live OAuth:** a publisher-issued desktop OAuth client,
   enabled Gmail/Drive APIs, consent-screen/test-user setup, user consent, and
   safe test data are required. The present installers intentionally remain
   unconfigured rather than pretending to connect.
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

## Conclusion

OmniCode 0.3.0 is ready for controlled Intel macOS Sonoma testing as an unsigned
release candidate, with statically verified Apple Silicon installers. It is not
ready to be labeled a signed, notarized public macOS release until the external
Apple, matching-hardware, OAuth, and configured-service gates above are completed.
