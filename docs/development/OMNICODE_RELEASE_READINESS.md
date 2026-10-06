# OmniCode Release Readiness

Last updated: 2026-10-01

## Overall Status

**NOT READY for a signed public release.**

OmniCode 0.9.0 is ready for controlled macOS testing as an internal build. A
native Apple Silicon app and DMG now pass architecture, strict bundle-signature,
mounted-image equivalence, packaged Code/Work, real zsh PTY, localhost, Omni,
Cursor-helper, and Speech-helper checks on an Apple M6 Mac. The validated build
is deliberately ad-hoc signed and unnotarized, so Gatekeeper still rejects a
quarantined/downloaded copy; it is a diagnostic artifact, not a public release.
The AI usage/cost system,
conditional Google
Workspace provider policy, separate connected-data consent, existing compact
Omni overlay and macOS permissions, Code/Work surfaces, and shared backends pass
the current automated gates. Developer ID signing, notarization, clean-TCC
interactive prompt coverage, a live verified Paid Gemini Workspace workflow,
missing service credentials/models, and a stable Apple distribution identity
remain explicit release gates.

The stabilization matrix currently records **269 of 295 behaviors passing
(91.2%)**. Eighteen are externally blocked, three are accurately not
implemented, and five are partially verified. No blocked, partial, or absent
capability is counted as passing.

## Test Summary

| Result | Count | Meaning |
| --- | ---: | --- |
| Tests passed | 269 | Tracked behavior met the stated expectation |
| Tests failed | 0 | No tracked behavior currently has a failing result |
| Tests blocked | 18 | Credential, service, billing/reconciliation, signing, safe-data, runtime, repository, or matching hardware required |
| Tests not run / not implemented | 3 | Accurately absent behavior is not presented as complete |
| Tests partially run | 5 | Safe or platform-dependent portions pass; a remaining real-world gate is documented |

Automated regression result: **701 passed, 7 intentionally skipped, 0 failed**
across 80 files (78 passing and two skipped). The native Keychain test is
excluded from the ordinary run because it changes the user's login Keychain;
the real Ollama integration suite is separately gated because it depends on a
running local service and model. TypeScript checking,
the 3,123-module multi-entry production build, native arm64 helper build, and
the current native Apple Silicon diagnostic package pass. Historical x64
package evidence remains recorded separately.

Packaged Intel evidence includes:

- startup and authorized workspace IPC;
- a real zsh PTY command and captured output;
- localhost serving with `.git` and `.env` denied;
- Cursor helper/readiness and Speech/TTS capability reporting;
- the nine-stage Omni setup, responsive layouts, Reduce Motion, and persistence;
- the 320×248 inactive overlay, restricted preload, contextual microphone
  permission state, removed dashboard controls, and zero renderer errors;
- external-navigation denial;
- idempotent disabled login-item synchronization with no repeated unsigned-build
  stderr on the final isolated-profile smoke.

Current Apple Silicon evidence includes:

- Apple M6 host, arm64 Node/Electron/active `node-pty`, and arm64 Cursor/Speech
  helpers;
- strict recursive bundle verification after a complete outer-bundle ad-hoc
  seal (the prior unsigned electron-builder output failed this check);
- packaged Code/Omni smoke with real zsh PTY, localhost access controls,
  navigation denial, TTS, and helper readiness;
- packaged Work smoke with persistence, Managed Browser, Gmail/Drive tool
  registration, result previews, and zero renderer errors;
- `en-US` on-device Speech was requested, supported, and active through the
  system-default `Shresht’s AirPods` input at 48,000 Hz mono; both permissions,
  real partial/final text, Auto, Enter, override, long, empty, and reuse flows
  were exercised;
- a verified, read-only mounted DMG whose app is filesystem-equivalent to the
  prepackaged app.

## Subsystems

| Subsystem | Readiness | Evidence / limitation |
| --- | --- | --- |
| Editor | ✅ Ready | Real Monaco editing, tabs, dirty state, save/autosave, shortcuts, conflicts, languages, and resizing pass existing packaged/unit gates |
| Filesystem | ✅ Ready | Real scoped create/open/rename/move/duplicate/trash/dialog operations match disk state and workspace boundaries |
| Terminal | ✅ Ready | Current arm64 package launched zsh in the selected workspace and captured the exact smoke marker; the active packaged `node-pty` binary is arm64 |
| Run / Compile | 🟡 Installed tools ready | Python, Node, C, C++, Swift, Java, npm, failures, stdout/stderr, and exit status pass; unavailable host runtimes remain external |
| Local Server | ✅ Ready | Final package served public files, denied sensitive paths, selected a valid port, and stopped cleanly |
| Git | ✅ Ready | Disposable repository init/status/diff/stage/unstage/commit/branch/clone/fetch/pull/push paths pass existing real integration gates |
| GitHub | 🔵 Blocked for authenticated writes | Public clone works; a safe writable remote plus HTTPS/SSH credentials is required for authenticated mutation evidence |
| Ollama | 🟡 Simple local tools verified | Ollama 0.34.4 and `phi3:mini` are live on this host. Settings/model switching, streaming, one Work ToolRegistry turn, and one complete Omni `runtime.detect` workflow pass; the latest strict live suite passed 3/6 because Phi-3 is not reliable for broader multi-step sequencing |
| OpenAI | 🔵 Blocked for live success | Adapter, Keychain, request shaping with `store: false`, invalid-auth, and redaction pass; valid account access is unavailable |
| Claude | 🔵 Blocked for live success | Adapter, Keychain, request/error/redaction paths pass; valid account access is unavailable |
| Gemini | 🟡 Account/provider dependent | Prior real API-key and model workflows pass; transient provider availability and account quota remain external |
| Google Workspace AI policy | ✅ Ready around external plan gate | Free/unknown/expired Gemini fails closed; verified Paid plus separate consent enables shared tools; credential rotation, expiry, provider switching, provenance, private storage, and connected-state UI pass. The final live Paid workflow is externally blocked |
| AI Chat | ✅ Implemented behavior ready | Provider/model routing, Markdown/code, context, errors, Work streaming/Stop, and clear behavior pass their documented scopes |
| AI Usage & Cost | ✅ Ready with estimated-cost limitation | Shared provider boundary, native token/cache/reasoning metadata, SQLite aggregation, real dashboard, budgets, retention, export/privacy, and deletion pass. Unknown model prices remain unavailable and provider billing is authoritative |
| Workspace Indexer | ✅ Ready | Initial/change/delete/rename freshness, ignores, binary/sensitive exclusions, ranking, and large-workspace responsiveness pass |
| AI Agent | ✅ Implemented workflow ready | Real tools, plans, approvals, pause/resume/stop, intervention, cleanup, redaction, and false-success prevention pass; Stop teardown race was repaired |
| Diff System | ✅ Ready | Create/modify/delete proposals, accept/reject, filesystem match, undo, and traversal denial pass |
| Settings | ✅ Ready | Private atomic persistence, corruption recovery, real Omni permission actions, setup rerun, and provider/permission state pass |
| Keychain | ✅ Ready | Save/read/restart/update/delete passed with disposable credentials; secrets remain out of renderer state, logs, workspace, and Git |
| macOS Integration | 🟡 Internal-build ready | Menus, dialogs, shortcuts, overlay, supported permission requests, Settings routing, and return refresh are implemented; the current arm64 app runs locally, but public TCC identity stability requires Developer ID signing/notarization |
| Production Build | 🟡 Ad-hoc diagnostic only | The current arm64 and cross-built x64 app/DMG pairs each pass 48 validation checks with 7 expected trust warnings and 0 structural/signature failures. Arm64 runtime/voice smokes pass; the x64 artifact still requires real Intel runtime testing. Gatekeeper rejects both because they have no Developer ID or notary ticket |

## Omni 0.7.0 Verification

### Global Overlay

- One singleton 320×248 borderless window appears at the active display's
  top-right work area and uses `showInactive()`.
- Packaged inspection measured `document.hasFocus() === false`.
- No textarea, input, Course of Action, Current Step, Activity, provider,
  execution, approval, or history control exists in the overlay.
- The overlay exposes `window.omniOverlay` and does not expose the privileged
  `window.omnicode` API.
- Thirteen waveform bars render; normalized native microphone amplitude is
  bounded and throttled before IPC.
- Permission-needed, starting, listening, finishing-transcript, thinking,
  working, speaking, completed, cancelled, and failure states are implemented;
  successful results auto-dismiss only after work/speech ends. Partial text is
  replaced live and kept inside a fixed-height scrolling region.
- Reduce Motion disables waveform animation. The live overlay renderer logged
  no errors.

### macOS Permissions

- `MacOSPermissionManager` centralizes detect, request, explain, open Settings,
  refresh, and verify behavior.
- Microphone, Speech Recognition, Accessibility, Screen Recording,
  Notifications, and Launch at Login invoke supported real workflows.
- A first Accessibility request uses Apple's native prompt; an explicit retry
  after decline opens the exact Accessibility pane.
- Speech authorization is requested independently from recognizer/locale asset
  availability.
- The command-line Speech helper embeds stable identity
  `com.omnicode.editor.speech-helper` plus Microphone/Speech purpose strings,
  and retains only the audio-input entitlement after package resealing.
- Automation remains accurately per target, and Files & Folders remains
  user-selection scoped; neither is shown as a fake universal grant.
- Settings-return activation performs one refresh and broadcast without a
  polling loop.
- The clean-TCC Allow/Deny matrix still requires interactive testing on signed,
  stable app identities. No TCC database manipulation is used.

## Release Artifacts

Current architecture-specific diagnostic artifacts:

| Target | Artifact | Size | SHA-256 |
| --- | --- | ---: | --- |
| Apple Silicon ad-hoc diagnostic installer | `dist/release-arm64/OmniCode-0.9.0-arm64.dmg` | 142,640,256 bytes | `1c048247aa0c9972ea0a215dec870460acad8c7d0c42ac12d011866bdcd91728` |
| Intel ad-hoc diagnostic installer (cross-built) | `dist/release-x64/OmniCode-0.9.0-x64.dmg` | 149,360,847 bytes | `eb2106e9234d0afdbcc37dbc2933295679ab8809573cd24c13bdd545fc314695` |

These artifacts were built with the restored external publisher-credential
source. Both packages contain the required trusted-main publisher fields, do
not contain the private JSON document, and do not depend on the development
Mac's absolute credentials path.

The current Intel artifact is a validated x86_64 cross-build. Rosetta 2 is not
installed on this Apple Silicon host, so the current artifact has not received
a runtime smoke; a real Intel Mac remains the required native execution gate.

The following checksums are historical repository records. Those artifacts
were not present after the migration and were not regenerated by the current
audit:

| Target | Artifact | Size | SHA-256 |
| --- | --- | ---: | --- |
| Intel installer | `dist/OmniCode-0.9.0-x64.dmg` | 147,430,062 bytes | `6f8197f45c1947a75f6a6b8e7ba3b1036017c17d4e35cd0f1fb3d1c6aafcbf33` |
| Intel archive | `dist/OmniCode-0.9.0-x64.zip` | 145,470,705 bytes | `815fb480b73b8ce93b9b7ae97d1e7778f166a32a3dd9946df66ed649cebe286c` |
| Apple Silicon installer | `dist/OmniCode-0.9.0-arm64.dmg` | 143,755,104 bytes | `217195f2f30ac8360c37dfc93df23ae35ee488cc89f73065a0c5dea408b7c7d4` |
| Apple Silicon archive | `dist/OmniCode-0.9.0-arm64.zip` | 141,754,291 bytes | `14a64f4a612e4f9910b17af1f66371ae40f243342e77832cb516ea48f8a6f86f` |

Their checksums were recorded in `dist/OmniCode-0.9.0-SHA256SUMS.txt` during the
earlier Intel-host audit.

## Remaining Problems

1. **Apple signing/notarization:** no Developer ID Application identity or
   notarization credentials are installed. The current ad-hoc artifact is
   structurally sound but is rejected after quarantine because it has no trusted
   Apple distribution identity or notary ticket.
2. **Google OAuth external verification:** the build input and packaged
   publisher configuration are repaired. Google verification/production status
   and any external consent-screen review remain outside the package build.
3. **Interactive privacy matrix:** real clean-TCC Allow, Deny, later recovery,
   System Settings return, and restart-required behavior must be exercised for
   each applicable permission on a signed stable build. This host reports the
   `en-US` on-device Speech recognizer available and microphone granted, but
   Speech remains `not-determined` and no input device is connected, so real
   transcription is unverified.
4. **Post-quit activation:** resident shortcut and launch-at-login work are
   implemented; there is no separately signed native helper after explicit
   Command-Q.
5. **Local wake phrase:** no licensed, bundled, measured offline wake engine or
   model exists. The UI does not claim that it does.
6. **External AI/services:** successful OpenAI, Claude, Ollama, authenticated
   GitHub write, and the live Paid-Gemini Workspace workflow require external
   credentials, verified account plan, consent, service availability, quota,
   models, disposable data, or a safe repository.
7. **Live Gmail/Drive mutations:** controlled tests pass, but real writes still
   require explicit approval and disposable user data.
8. **Advanced screen/semantic control:** Cursor's structured Accessibility
   foundation works; general screen-pixel understanding and broader semantic
   cross-app targeting remain partial and permission/signing dependent.

## Conclusion

OmniCode 0.9.0 has verified **architecture-specific ad-hoc diagnostic builds**.
The native arm64 app runs locally; the cross-built x64 app is structurally and
cryptographically valid but still needs real Intel execution. Quarantined
copies are expected to show Apple's unverified-malware warning. Neither is ready
to be labeled a signed/notarized public macOS release until the Apple identity,
notarization, permission, OAuth-input, runtime, and external-service gates above
are completed.
