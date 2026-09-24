# OmniCode Release Readiness

Last updated: 2026-09-24

## Overall Status

**NOT READY for a signed public release.**

OmniCode 0.8.0 is ready for controlled Intel macOS Sonoma testing as an
unsigned internal build. Its Apple Silicon package is structurally verified,
but still requires execution on matching hardware. The conditional Google
Workspace provider policy, separate connected-data consent, existing compact
Omni overlay and macOS permissions, Code/Work surfaces, and shared backends pass
the current automated gates. Developer ID signing, notarization, clean-TCC
interactive prompt coverage, a live verified Paid Gemini Workspace workflow,
missing service credentials/models, and arm64 runtime execution remain explicit
release gates.

The stabilization matrix currently records **257 of 284 behaviors passing
(90.5%)**. Eighteen are externally blocked, three are accurately not
implemented, and six are partially verified. No blocked, partial, or absent
capability is counted as passing.

## Test Summary

| Result | Count | Meaning |
| --- | ---: | --- |
| Tests passed | 257 | Tracked behavior met the stated expectation |
| Tests failed | 0 | No tracked behavior currently has a failing result |
| Tests blocked | 18 | Credential, service, billing-plan verification, signing, permission, safe-data, runtime, repository, or matching hardware required |
| Tests not run / not implemented | 3 | Accurately absent behavior is not presented as complete |
| Tests partially run | 6 | Safe or platform-dependent portions pass; a remaining real-world gate is documented |

Automated regression result: **611 passed, 1 intentionally skipped, 0 failed**
across 71 files (70 passing and one skipped). The skipped native Keychain test
is excluded from the ordinary run because it changes the user's login Keychain;
that boundary has separate disposable-credential evidence. TypeScript checking,
the 3,122-module multi-entry production build, x86_64 and arm64 native helper
builds, and both architecture-specific packages pass.

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

## Subsystems

| Subsystem | Readiness | Evidence / limitation |
| --- | --- | --- |
| Editor | ✅ Ready | Real Monaco editing, tabs, dirty state, save/autosave, shortcuts, conflicts, languages, and resizing pass existing packaged/unit gates |
| Filesystem | ✅ Ready | Real scoped create/open/rename/move/duplicate/trash/dialog operations match disk state and workspace boundaries |
| Terminal | ✅ Ready | Final 0.8.0 x64 package launched zsh in the selected workspace and captured the exact smoke marker; PTY architecture is correct in both packages |
| Run / Compile | 🟡 Installed tools ready | Python, Node, C, C++, Swift, Java, npm, failures, stdout/stderr, and exit status pass; unavailable host runtimes remain external |
| Local Server | ✅ Ready | Final package served public files, denied sensitive paths, selected a valid port, and stopped cleanly |
| Git | ✅ Ready | Disposable repository init/status/diff/stage/unstage/commit/branch/clone/fetch/pull/push paths pass existing real integration gates |
| GitHub | 🔵 Blocked for authenticated writes | Public clone works; a safe writable remote plus HTTPS/SSH credentials is required for authenticated mutation evidence |
| Ollama | 🔵 Blocked for real inference | Honest absent/stopped handling passes; Ollama and an installed model are not available on this host |
| OpenAI | 🔵 Blocked for live success | Adapter, Keychain, request shaping with `store: false`, invalid-auth, and redaction pass; valid account access is unavailable |
| Claude | 🔵 Blocked for live success | Adapter, Keychain, request/error/redaction paths pass; valid account access is unavailable |
| Gemini | 🟡 Account/provider dependent | Prior real API-key and model workflows pass; transient provider availability and account quota remain external |
| Google Workspace AI policy | ✅ Ready around external plan gate | Free/unknown/expired Gemini fails closed; verified Paid plus separate consent enables shared tools; credential rotation, expiry, provider switching, provenance, private storage, and connected-state UI pass. The final live Paid workflow is externally blocked |
| AI Chat | ✅ Implemented behavior ready | Provider/model routing, Markdown/code, context, errors, Work streaming/Stop, and clear behavior pass their documented scopes |
| Workspace Indexer | ✅ Ready | Initial/change/delete/rename freshness, ignores, binary/sensitive exclusions, ranking, and large-workspace responsiveness pass |
| AI Agent | ✅ Implemented workflow ready | Real tools, plans, approvals, pause/resume/stop, intervention, cleanup, redaction, and false-success prevention pass; Stop teardown race was repaired |
| Diff System | ✅ Ready | Create/modify/delete proposals, accept/reject, filesystem match, undo, and traversal denial pass |
| Settings | ✅ Ready | Private atomic persistence, corruption recovery, real Omni permission actions, setup rerun, and provider/permission state pass |
| Keychain | ✅ Ready | Save/read/restart/update/delete passed with disposable credentials; secrets remain out of renderer state, logs, workspace, and Git |
| macOS Integration | 🟡 Internal-build ready | Menus, dialogs, shortcuts, overlay, supported permission requests, Settings routing, and return refresh are implemented; public TCC stability requires signing |
| Production Build | 🟡 Unsigned release candidate | Both 0.8.0 DMG/ZIP sets pass integrity, version, icon, Applications link, and Electron/helper/node-pty architecture checks; x64 passed the final isolated-profile live smoke |

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
- Permission-needed, listening, understanding, working, speaking, completed,
  and failure states are implemented; successful results auto-dismiss only
  after work/speech ends.
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
- Automation remains accurately per target, and Files & Folders remains
  user-selection scoped; neither is shown as a fake universal grant.
- Settings-return activation performs one refresh and broadcast without a
  polling loop.
- The clean-TCC Allow/Deny matrix still requires interactive testing on signed,
  stable app identities. No TCC database manipulation is used.

## Release Artifacts

| Target | Artifact | Size | SHA-256 |
| --- | --- | ---: | --- |
| Intel installer | `dist/OmniCode-0.8.0-x64.dmg` | 147,409,052 bytes | `465dedb0228671243f5123d561e7f1e58ba727f0c812e057084ea583cefa2235` |
| Intel archive | `dist/OmniCode-0.8.0-x64.zip` | 145,451,783 bytes | `505f8fea614a24449320ed5ed348370fcd3b80b905496acecaa73a42750e0fd0` |
| Apple Silicon installer | `dist/OmniCode-0.8.0-arm64.dmg` | 143,735,581 bytes | `109c1902c158d7a1bdb90d69f82e4023f5edb95a260d9ee223c7805af63668cb` |
| Apple Silicon archive | `dist/OmniCode-0.8.0-arm64.zip` | 141,735,330 bytes | `4705e2e89d1da3bfb3a64bfd6c557c1f56f9acd5b858c823001f29bdf00f0705` |

Checksums are recorded in `dist/OmniCode-0.8.0-SHA256SUMS.txt`,
`dist/SHA256SUMS-0.8.0.txt`, and the cumulative `dist/SHA256SUMS.txt`.

## Remaining Problems

1. **Apple signing/notarization:** no Developer ID Application identity or
   notarization credentials are installed. These internal builds can require
   an explicit user trust action and cannot be called public-release-ready.
2. **Apple Silicon execution:** the Electron executable, Cursor helper, Speech
   helper, and `node-pty` bundle are all arm64 and the DMG/ZIP verify, but the
   app has not run on Apple Silicon hardware in this audit.
3. **Interactive privacy matrix:** real clean-TCC Allow, Deny, later recovery,
   System Settings return, and restart-required behavior must be exercised for
   each applicable permission on a signed stable build. The current host lacks
   the `en-US` on-device Speech asset, so real transcription is blocked.
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

OmniCode 0.8.0 is a verified **unsigned internal Intel release candidate** with
a structurally verified Apple Silicon counterpart. It is not ready to be
labeled a signed/notarized public macOS release until the remaining Apple,
matching-hardware, permission, and external-service gates above are completed.
