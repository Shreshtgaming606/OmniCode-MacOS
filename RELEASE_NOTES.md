# OmniCode 0.1.1 macOS local release

Build date: 2026-09-05

## Status

OmniCode 0.1.1 is built for macOS Sonoma on Intel and Apple silicon. This
maintenance release fixes cloud credential persistence and adds real installers
and model downloads to first-launch setup.

The artifacts are unsigned and unnotarized because no Apple Developer ID
identity is installed on the build machine. They are suitable for local
installation and testing. Public distribution still requires signing,
notarization, stapling, and an Apple-silicon hardware smoke test.

## Improvements

- Missing supported tools can be installed from setup with progress,
  cancellation, retry, and detection refresh.
- Homebrew and Ollama official installers are downloaded in-app when needed.
  Formulae install through Homebrew; Java, .NET, and Docker downloads open
  their native macOS installers for approval.
- Ollama can be installed or started from setup. Hardware-ranked coding models
  show download/memory sizes and download with live progress and cancellation.
- Cloud API key saves now use a deterministic Keychain write and exact readback
  verification. OpenAI, Anthropic, and Google credentials persist across app
  launches; Keychain failures remain visible instead of appearing saved.
- Cloud response parsing reports empty, blocked, refused, and truncated replies
  clearly. Provider/model changes remain synchronized while the app is open.
- Fresh-Mac detection no longer invokes Apple's developer-tool shims during a
  background refresh, so the Apple installer appears only after Install is
  selected.
- Existing users can reopen setup from **OmniCode → Setup & Install Tools…** or
  the command palette.

Users upgrading from 0.1.0 should re-enter any cloud key once if OmniCode says
it is missing. The previous save flow could create an empty Keychain value, and
an absent secret cannot be recovered.

## Artifacts

| Artifact | Architecture | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `OmniCode-0.1.1-x64.dmg` | Intel x86-64 | 146,736,337 | `e394058e6d056e3d351f883ddb0a30e5fb861584d4f86a35e7562e8de4b330ac` |
| `OmniCode-0.1.1-x64.zip` | Intel x86-64 | 144,774,360 | `460de99df768a0062a41a0831df5c5e2dd9d10ca73dc9689e75117ce33f1d3a7` |
| `OmniCode-0.1.1-arm64.dmg` | Apple silicon | 143,062,119 | `7cc9224e2683a01b6e6a8b9d12de003390f1a8c68449a4b7a2ea06ea525d7def` |
| `OmniCode-0.1.1-arm64.zip` | Apple silicon | 141,058,239 | `8845169aba5d5d0286cac276a8dade416a794896d3628d6f2b32ed37052cb970` |

## Verification

- TypeScript and production bundles: passed
- Vitest: 18 files, 185 tests passed; native Keychain test run separately
- Native disposable-Keychain roundtrip/replace/reopen/delete: passed for all
  three cloud providers; existing credentials were untouched
- Production dependency audit: zero known vulnerabilities
- Intel setup walkthrough at normal and 960 × 600 sizes: passed
- Intel packaged launch, workspace/preload IPC, real zsh PTY, and offline Monaco:
  passed
- Static-server public file and secret-denial checks: passed
- Remote same-window navigation prevention: passed
- Packaged renderer runtime/log errors: none
- Intel and Apple-silicon DMG/ZIP integrity: passed
- Electron and native `node-pty` slices match each advertised architecture

## Release boundaries

The app has not made paid live requests with user cloud credentials; request
authentication, payloads, response handling, and persistence are regression
tested with mocks and an isolated native Keychain. Installer tests do not alter
the build Mac. Native installers can still require license acceptance and
administrator approval. See the README and `docs/ARCHITECTURE.md` for details.
