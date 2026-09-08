# OmniCode Release Readiness

Last updated: 2026-09-08

## Overall Status

**NOT READY for a signed public release.**

The stabilization and repair work that can be completed on the current Intel
macOS Sonoma host is complete. The final Intel package passed its executable
smoke and extended audits, both architecture-specific distributions pass static
package validation, and no tracked test currently fails. Public release remains
blocked by Apple signing/notarization and matching-hardware Apple Silicon launch
validation. Service/account-specific checks remain blocked where the required
credential, authenticated repository, Ollama installation, model, or runtime is
not available.

The matrix result is 114 of 129 tracked behaviors passing (88.4%). Twelve are
externally blocked, two accurately describe capabilities that are not
implemented or claimed, and one is partially exercised. This is not a claim that
blocked work passed.

## Test Summary

| Result | Count | Meaning |
| --- | ---: | --- |
| Tests passed | 114 | Observed behavior met the stated expectation |
| Tests failed | 0 | No currently tracked test has a known failing result |
| Tests blocked | 12 | External credential, service, hardware, runtime, repository, or certificate required |
| Tests not run / not implemented | 2 | Streaming/stop generation and layout persistence are absent and not presented as complete |
| Tests partially run | 1 | Failure mapping is covered, but a physically disconnected-network E2E was not performed |

Automated regression result: **247 passed, 1 intentionally skipped, 0 failed**.
The skipped test is the native Keychain integration inside the ordinary suite;
that behavior was executed separately with disposable credentials and passed.

## Subsystems

| Subsystem | Readiness | Evidence / limitation |
| --- | --- | --- |
| Editor | ✅ Ready | Real multi-tab editing, Monaco features, native shortcuts, save/autosave/conflicts, and dirty-close flows passed |
| Filesystem | ✅ Ready | Real create/open/rename/move/duplicate/trash/drag/drop/native-dialog operations matched disk and workspace boundaries |
| Terminal | ✅ Ready | Real zsh PTY, cwd, environment, PATH, interaction, sessions, resize, scroll, clipboard, and cleanup passed |
| Run / Compile | 🟡 Ready for installed tools | Python, Node, C, C++, Swift, Java, npm, custom pipeline, failures, stdout/stderr/exit code passed; Rust/Go unavailable on host |
| Local Server | ✅ Ready | Static and npm servers, assets, live reload, browser update, conflicts, restart/stop/port release passed |
| Git | ✅ Ready | Init/status/diff/stage/unstage/commit/branch/clone/fetch/pull/push passed with real repositories |
| GitHub | 🔵 Blocked for authenticated writes | Public HTTPS clone passed; safe authenticated HTTPS/SSH write remote and credentials were unavailable |
| Ollama | 🔵 Blocked for real model lifecycle | Absent/stopped/available state handling is covered and host absence is accurate; service and model required for list/pull/delete/inference E2E |
| OpenAI | 🔵 Blocked for successful live response | Adapter and real stored-invalid-key/redacted-auth path passed; valid funded credential required |
| Claude | 🔵 Blocked for live response | Adapter request/error behavior passed; valid credential required |
| Gemini | ✅ Ready | Existing Keychain credential authenticated; real Chat, Markdown, multi-file context, and Agent workflows returned correct results |
| AI Chat | ✅ Ready for implemented behavior | Provider switching, messages, Markdown/code, clear, context and honest errors passed; streaming/stop and restart history are not implemented |
| Workspace Indexer | ✅ Ready | Watcher freshness, ranking, ignores, binary/sensitive exclusions and responsive 1,203-file workload passed |
| AI Agent | ✅ Ready for implemented proposal workflow | Multi-file planning, staged review, accept/undo, safe command suggestion, native approval and PTY execution passed |
| Diff System | ✅ Ready | Modify/create/delete staging, accept/reject, filesystem match, undo and traversal denial passed |
| Settings | ✅ Ready | User and workspace settings validation, atomic persistence, restart restoration, corrupt-input handling and mode `0600` passed |
| Keychain | ✅ Ready | Save/read/restart/update/delete passed with disposable credentials; final leak scan found no credential outside Keychain |
| macOS Integration | 🟡 Partially ready | Menus, dialogs, shortcuts, Finder, window lifecycle, themes and file associations passed; notifications/public trust require signed build |
| Production Build | 🟡 Installers verified, release gate blocked | Typecheck/build and four artifacts pass; Intel launch passed; Apple Silicon launch and Apple signing/notarization remain blocked |

## Release Artifacts

| Target | Artifact | Size | SHA-256 |
| --- | --- | ---: | --- |
| Apple Silicon installer | `dist/OmniCode-0.1.1-arm64.dmg` | 143,447,563 bytes | `57953af42f987b977e9292ad3bb4a4080ab398f08b5b25e3a175151a5c466aca` |
| Apple Silicon archive | `dist/OmniCode-0.1.1-arm64.zip` | 141,453,054 bytes | `234f8b5f7ea5654ff121d62554efd7627c3caff864a8d81b1b69318b1a6b0036` |
| Intel installer | `dist/OmniCode-0.1.1-x64.dmg` | 147,122,375 bytes | `cc6679f091a38d46c63861ab71c308645eef5bd57a39bef7abfcde9f25f47065` |
| Intel archive | `dist/OmniCode-0.1.1-x64.zip` | 145,169,165 bytes | `dc01cc79d0026e4487d87a2ed49696ebd1b0d873bca68b3b7aba5c6a5045b409` |

Checksums are also recorded in `dist/SHA256SUMS.txt`.

## Remaining Problems

1. **Apple signing/notarization:** a Developer ID Application certificate and
   notarization credentials are required. Until then, Gatekeeper trust and
   Notification Center delivery are not release-ready.
2. **Apple Silicon execution:** the arm64 package passes architecture/archive
   inspection but needs a launch and smoke run on a matching Mac.
3. **OpenAI and Claude live success:** valid credentials/account access are not
   configured. Their adapter, Keychain, invalid-auth, redaction, and error paths
   are covered.
4. **Ollama model lifecycle and inference:** Ollama and a local model are absent
   on this host. Absence and failure states are verified without fake success.
5. **Authenticated GitHub writes:** a safe writable remote and credentials are
   required for real HTTPS/SSH fetch/pull/push authentication checks.
6. **Missing host runtimes:** Rust/Cargo and Go are absent. Setup correctly
   offers installation, confirmation and honest failure/cancel states; the
   current Homebrew ownership condition blocks unattended successful install.
7. **Inline AI model-backed edit:** selection/shortcut/request wiring is present,
   but its full proposal/accept/reject/save E2E remains blocked by the unavailable
   configured local backend.
8. **Physically disconnected-network E2E:** transport/rate/timeout mappings and
   real provider failures are covered; disabling the machine's network was not
   performed because it would disrupt the host session.

## Conclusion

OmniCode 0.1.1 is a verified **unsigned release candidate for Intel macOS
Sonoma**, with statically verified Apple Silicon artifacts. It is ready for the
external signing, notarization, Apple Silicon hardware, and configured-service
validation gates listed above. It is not yet appropriate to label as a signed,
notarized public macOS release.
