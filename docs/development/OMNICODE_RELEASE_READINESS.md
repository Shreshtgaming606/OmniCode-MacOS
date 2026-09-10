# OmniCode Release Readiness

Last updated: 2026-09-09

## Overall Status

**NOT READY for a signed public release.**

The stabilization work that can be completed on the current Intel macOS Sonoma
host remains green, and the new separate Work Mode core is implemented and
verified. The 0.2.0 Intel package passed both the core executable smoke and a
dedicated packaged Work smoke. Both architecture-specific distributions pass
static package validation, and no tracked test currently fails. Public release
remains blocked by Apple signing/notarization and matching-hardware Apple
Silicon launch validation. Service/account checks remain blocked where the
required OAuth client, credential, authenticated repository, Ollama service,
model, or runtime is unavailable.

The matrix result is 143 of 165 tracked behaviors passing (86.7%). Seventeen are
externally blocked, three accurately describe capabilities that are not
implemented or claimed, and two are partially exercised. This is not a claim
that blocked work passed.

## Test Summary

| Result | Count | Meaning |
| --- | ---: | --- |
| Tests passed | 143 | Observed behavior met the stated expectation |
| Tests failed | 0 | No currently tracked test has a known failing result |
| Tests blocked | 17 | External credential, OAuth client, service, hardware, runtime, repository, or certificate required |
| Tests not run / not implemented | 3 | Code Chat streaming/stop, rich-document attachment extraction, and layout persistence are absent and not presented as complete |
| Tests partially run | 2 | Failure mapping and refreshed UI source are covered, but physical-offline and packaged visual sweeps remain |

Automated regression result: **373 passed, 1 intentionally skipped, 0 failed**.
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
| Code AI Chat | ✅ Ready for implemented behavior | Account-visible model selector, provider switching, messages, Markdown/code, clear, context and honest errors passed; Code Chat streaming/stop and restart history are not implemented |
| Work Mode | ✅ Core ready | Separate surface, persistent conversations, history/search/pin, model selectors, streaming/Stop, Copy/Edit/Regenerate, text attachments, and packaged live Gemini passed |
| Work Agent / Tools | ✅ Ready for registered tools | Bounded provider-native tool loop, registry, schemas, scopes, permissions, redaction, cancellation, local-model gate and a real Gemini browser tool turn passed |
| Connected Apps | 🟡 Browser live; Google implementation awaiting live OAuth | Managed Browser passed live. Google system-browser OAuth, Keychain refresh/revoke, 11 Gmail tools and 12 Drive tools pass focused integration tests; registered client, consent, and live service tests are blocked |
| Gmail | 🔵 Live verification blocked | Real main-process REST tools and exact send/reply confirmation are implemented and tested without network side effects; Google OAuth client, Gmail API enablement, consent, and safe mailbox are required |
| Google Drive | 🔵 Live verification blocked | Real main-process Drive v3 tools, export, bounded text upload, mutation policies and binary-context refusal are implemented and tested; OAuth client, API enablement, consent, and safe Drive are required |
| Workspace Indexer | ✅ Ready | Watcher freshness, ranking, ignores, binary/sensitive exclusions and responsive 1,203-file workload passed |
| AI Agent | ✅ Ready for implemented proposal workflow | Multi-file planning, staged review, accept/undo, safe command suggestion, native approval and PTY execution passed |
| Diff System | ✅ Ready | Modify/create/delete staging, accept/reject, filesystem match, undo and traversal denial passed |
| Settings | ✅ Ready | User/workspace persistence, corrupt-input handling, mode `0600`, Work Mode section, Connected Apps state/actions, and dynamic model dropdowns passed |
| Keychain | ✅ Ready | Save/read/restart/update/delete passed with disposable credentials; final leak scan found no credential outside Keychain |
| macOS Integration | 🟡 Partially ready | Menus, dialogs, shortcuts, Finder, window lifecycle, themes and file associations passed; notifications/public trust require signed build |
| Production Build | 🟡 Installers verified, release gate blocked | Typecheck/build and four 0.2.0 artifacts pass; Intel core + Work smokes passed; Apple Silicon launch and Apple signing/notarization remain blocked |

## Release Artifacts

| Target | Artifact | Size | SHA-256 |
| --- | --- | ---: | --- |
| Apple Silicon installer | `dist/OmniCode-0.2.0-arm64.dmg` | 143,509,140 bytes | `450678b12e2a6cdc784ffca0697871ed96b34621b16685ee4a65dbf030884842` |
| Apple Silicon archive | `dist/OmniCode-0.2.0-arm64.zip` | 141,498,951 bytes | `6608bd38b912ca27d35203de899d9eebfe284660a7c604eb1b545d41b89ea376` |
| Intel installer | `dist/OmniCode-0.2.0-x64.dmg` | 147,183,903 bytes | `8b18d77bede8a094ca3817861808ce2030b9477f06280f27d718a494d7e2e054` |
| Intel archive | `dist/OmniCode-0.2.0-x64.zip` | 145,215,095 bytes | `da8d185acc802800f5b150b0de3affe09866846a7c00e90a75ede86dd9e946ac` |

Checksums are recorded in `dist/SHA256SUMS.txt` and the release-specific
`dist/SHA256SUMS-0.2.0.txt`.

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
9. **Google Workspace live OAuth:** the secure system-browser/PKCE/Keychain
   implementation and Gmail/Drive API tools now exist, but a publisher-issued
   desktop OAuth client, enabled APIs, consent, and safe Gmail/Drive test data
   are required. Microsoft 365 and Discord also remain external requirements.
10. **Rich Work attachments:** bounded text/source attachments are verified;
    PDF, Word, spreadsheet, and image extraction needs dedicated parsers and is
    explicitly unsupported in this build.
11. **Code Chat streaming/persistence:** Work Mode implements and verifies
    streaming, Stop, and persistent history; the older Code Chat remains final-
    response-only and nonpersistent, without claiming otherwise.

## Conclusion

OmniCode 0.2.0 is a verified **unsigned release candidate for Intel macOS
Sonoma**, including the separate Work Mode core, with statically verified Apple
Silicon artifacts. It is ready for the external signing, notarization, Apple
Silicon hardware, OAuth, and configured-service validation gates listed above.
It is not yet appropriate to label as a signed, notarized public macOS release.
