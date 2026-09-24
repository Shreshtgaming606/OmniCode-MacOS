# OmniCode 0.8.0 macOS internal release

Build date: 2026-09-23

## Status

OmniCode 0.8.0 is an unsigned internal build for macOS Sonoma on Intel and
Apple silicon. It repairs how Work Mode handles Gmail/Google Drive data with
cloud AI providers while preserving the existing editor, terminal, agents,
Omni, OAuth, and connector implementations.

The artifacts are not signed or notarized because no Apple Developer ID
identity is installed on the build machine. The Intel package is exercised on
the current Intel Sonoma host. The Apple-silicon package is structurally
verified but still requires execution on matching hardware.

## Google Workspace AI-data repair

- Gmail and Google Drive can remain connected while the selected AI provider is
  separately unavailable for their data.
- Free, unpaid, unknown, and expired Gemini configurations fail closed.
- A Paid Gemini Developer API configuration becomes eligible only after the
  saved key passes a live connection test and the user confirms the matching AI
  Studio project/key and Paid status.
- Verification is bound to a one-way credential fingerprint, expires after
  seven days, and is invalidated if the credential changes.
- Eligible cloud providers still require explicit, revocable connected-data
  consent. Eligibility is never treated as consent.
- Workspace-derived conversation history is provenance-marked and rechecked
  before it can be sent after a provider switch.
- Model-visible Gmail/Drive results remain minimum, bounded, redacted, and
  untrusted. Credentials, OAuth tokens, authorization headers, binary bytes,
  and raw local paths are not transferred.
- Gemini requests explicitly set `store: false`. This is a request preference;
  Paid service is not represented as zero data retention.

Google does not expose billing tier through an ordinary Gemini API key. The
current implementation therefore uses an honest, expiring AI Studio
confirmation plus live-key verification instead of pretending billing was
automatically detected.

## Verification

- Provider-policy, Work-agent, Gemini adapter, IPC, Settings, and Work renderer
  focused regressions passed.
- Four controlled Gmail/Drive cross-workflows passed after explicit eligible-
  provider consent, including opaque binary transfer and untrusted-content
  handling.
- Credential rotation, expiry, provider switching, historical provenance, and
  policy-store secret-leak paths have regression coverage.
- TypeScript, the complete serial suite, production build, both installer
  targets, artifact integrity, architecture, and checksums are release gates.
- Final result: 611 tests passed, 1 native-Keychain test was intentionally
  skipped from the ordinary run, and 0 tests failed. The packaged Intel smoke
  passed real workspace IPC, zsh PTY, localhost boundaries, Omni readiness,
  navigation blocking, and error capture.

The real Gmail/Drive-to-Paid-Gemini workflow is **BLOCKED — USER CONFIGURATION
REQUIRED** until a verified Paid AI Studio project/key, explicit OmniCode
consent, and disposable safe test data are available. Controlled integrations
cover that path; this release does not fake a live success.

## Artifacts

| Artifact | Architecture | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `OmniCode-0.8.0-x64.dmg` | Intel x86-64 | 147,409,052 | `465dedb0228671243f5123d561e7f1e58ba727f0c812e057084ea583cefa2235` |
| `OmniCode-0.8.0-x64.zip` | Intel x86-64 | 145,451,783 | `505f8fea614a24449320ed5ed348370fcd3b80b905496acecaa73a42750e0fd0` |
| `OmniCode-0.8.0-arm64.dmg` | Apple silicon | 143,735,581 | `109c1902c158d7a1bdb90d69f82e4023f5edb95a260d9ee223c7805af63668cb` |
| `OmniCode-0.8.0-arm64.zip` | Apple silicon | 141,735,330 | `4705e2e89d1da3bfb3a64bfd6c557c1f56f9acd5b858c823001f29bdf00f0705` |

## Release boundaries

Public distribution still requires Developer ID signing, notarization,
stapling, stable clean-TCC permission testing, and an Apple-silicon hardware
smoke. External-provider success also depends on valid credentials, account
plan, quota, model availability, and service availability.
