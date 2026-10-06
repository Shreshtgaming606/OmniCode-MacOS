# OmniCode Beta v1 0.1.0

Prerelease for macOS 14+ on Apple silicon and Intel Macs. The version number
was intentionally reset from the prior website beta's 0.9.0 to Beta v1 0.1.0;
this is not a feature rollback.

This release brings together Code Mode, Work Mode, Omni voice and tools, local
Ollama and optional cloud providers, Gmail and Google Drive connectors, live
prompt activity, a persistent Notification Center, and the latest Omni voice
and optional ElevenLabs TTS work. Google OAuth publisher configuration is
embedded at build time without bundling the developer's private source JSON or
path.

## Validation

- TypeScript typecheck passed.
- Automated suite: 716 passed, 8 skipped, 0 failed.
- Both DMGs: 48 packaging checks passed, 7 expected trust warnings, 0 failed.
- The validator checked architecture, native helpers and `node-pty`, strict
  nested code signatures, resource sealing, DMG integrity, and checksums.
- Intel was cross-built on Apple silicon. A fresh runtime smoke test on a real
  Intel Mac has **not** been performed for this exact prerelease.

| Installer | SHA-256 |
| --- | --- |
| `OmniCode-0.1.0-arm64.dmg` | `e76ddbea96c5e6c056b439b893712aeee8ae2ec9cbff64942d64cc68706b33e3` |
| `OmniCode-0.1.0-x64.dmg` | `4f7e78a400ec15c77a81200cbd63937540b3f12cf0e0da55daff114a64f918f4` |

## Trust and testing limits

These are **ad-hoc signed, unnotarized beta builds**, not Developer ID-signed
or Apple-notarized releases. Apple Gatekeeper rejects them as trusted
distribution packages. Users should verify the checksum and review the source
before considering the macOS Privacy & Security exception; do not disable
system-wide security protections. A normal trusted install requires Developer
ID signing, notarization, and stapling.

Google OAuth verification and clean-account connector testing remain separate
release gates. ElevenLabs live speech generation was not validated with a
working account key for this build. The automated checks do not substitute for
fresh GUI, AirPods, Gmail/Drive, or Intel-hardware acceptance tests.
