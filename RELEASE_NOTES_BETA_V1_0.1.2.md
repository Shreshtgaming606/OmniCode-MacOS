# OmniCode Beta v1 0.1.2

OmniCode 0.1.2 includes the macOS integration work prepared for 0.1.1 plus
first-run and notification improvements. One application version is packaged
in four installers: Current for macOS 15+ and Sonoma Legacy for macOS 14,
each for Apple silicon and Intel.

## New in 0.1.2

- **Optional post-setup tour:** after the existing six-step setup, choose
  Start Tour or Skip. Nine short spotlights point to the real Code, Work,
  Omni, provider, connected-app, activity, notification, and settings UI.
  Settings → Help can restart the tour. Completion or skipping is remembered.
- **Notification Center repair:** the top-level bell and panel are accessible
  above the workspace, with unread count, filters, read/clear controls,
  persistence, and links to the originating Code task or Work conversation.
  A test or build command with a nonzero exit code is shown as failed even
  when the agent successfully reports that failure.
- **Omni Mode identity:** the supplied Omni Mode mark now appears across Omni
  navigation, setup, dashboard, voice overlay, settings, and tour. The main
  OmniCode application icon is unchanged.

## Included since the last GitHub release (0.1.0)

The 0.1.1 work, previously available on the website but not tagged on GitHub,
is included here. Current adds explicit on-device Apple Translation, Vision
OCR of authorized workspace images, and exact OmniCode-window capture.
Core Spotlight can index limited local metadata without prompt, email, or
Drive bodies. A packaged App Intents extension exposes seven Shortcuts actions
in both profiles; Current adds Translate Clipboard. Sonoma Legacy retains the
shared Code, Work, Omni, provider, connector, voice, activity, and notification
systems while hiding macOS-15-only native features. See
[0.1.1 notes](RELEASE_NOTES_BETA_V1_0.1.1.md) and
[macOS profile details](docs/platform/MACOS_SUPPORT.md).

## Download choices

| Installer | Mac | Minimum macOS |
| --- | --- | --- |
| `OmniCode-0.1.2-macOS15-arm64.dmg` | Apple silicon | 15.0 |
| `OmniCode-0.1.2-macOS15-x64.dmg` | Intel | 15.0 |
| `OmniCode-0.1.2-Sonoma-Legacy-arm64.dmg` | Apple silicon | 14.0 |
| `OmniCode-0.1.2-Sonoma-Legacy-x64.dmg` | Intel | 14.0 |

Each final DMG passed the release validator with **84 passes, 7 expected
ad-hoc/notarization warnings, and 0 failures**. TypeScript passed and the
automated suite had **748 passing tests, 8 skipped**. SHA-256 digests:

| Installer | SHA-256 |
| --- | --- |
| Current Apple silicon | `e6ca90d949c2d914e5e0aa54e89d5ad69c1bd49fdddef8b0ff01e164236face1` |
| Current Intel | `7fc224e6957b094ae30794c7e132aa39e286a76914755def01e7fcfc162e67c4` |
| Sonoma Legacy Apple silicon | `98f667ef2e90ccfc5749ba73d1fcbb37b1d662c2e76cb4fc7ed657360b9ac141` |
| Sonoma Legacy Intel | `7457e0aceb3cd5a35312fd391bd17f283f49c4baa6b38b100c222da8daa1168e` |

## Distribution and verification boundary

These beta installers are **ad-hoc signed and not notarized**. Strict
code-signature, resource-seal, architecture, DMG, and checksum checks verify
build integrity but do not confer Apple distribution trust. Gatekeeper may
block first launch. If you trust the download, try opening the copied app in
Finder, then use System Settings → Privacy & Security → Open Anyway. Do not
disable Gatekeeper system-wide.

Current arm64 was exercised in a real graphical session for the tour and
in-app notifications. Intel and macOS 14 installers are cross-built and
structurally validated, not claimed runtime-tested on those systems. Native
macOS notification delivery and the new mark's live voice-overlay appearance
remain separate manual checks. Existing tool approval, Keychain, OAuth, and
data-provenance controls are unchanged by the tour and notification UI.
