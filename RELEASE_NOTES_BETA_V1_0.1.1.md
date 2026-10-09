# OmniCode Beta v1 0.1.1

0.1.1 is the next beta after the published 0.1.0. It uses one Code/Work/Omni
source tree and two macOS profiles, each packaged separately for Apple Silicon
and Intel. Current requires macOS 15 or newer. Sonoma Legacy requires macOS 14
or newer. Both are version 0.1.1 and use the same user-data format.

## New in 0.1.1

- **Local macOS actions (Current):** explicit Apple Translation for selected
  text or clipboard content, Apple Vision OCR for workspace images, and exact
  OmniCode-window capture through ScreenCaptureKit. Apple Silicon can select an
  HDR capture preset. These are local native operations; Omni's window-reading
  tool requires explicit approval before recognized window text is sent to the
  selected model.
- **Core Spotlight:** an optional, metadata-only index for recent workspace
  names, eligible Work conversation titles, and fixed OmniCode actions.
  Settings can rebuild or clear OmniCode's own index. It excludes prompt and
  answer bodies, file contents, Gmail/Drive bodies, tokens, and browser pages.
  Current requests the macOS 15 semantic-search option; related-word matches
  are not guaranteed. Sonoma Legacy keeps lexical search.
- **macOS Shortcuts actions:** seven navigation/launch actions in both profiles:
  Open Code Mode, Open Work Mode, Open Omni Mode, Start Omni Voice, Ask Omni,
  Open Workspace, and Open Recent Workspace. Current adds Translate Clipboard.
  The extension is now built by a real Xcode app-extension target. On an
  unlocked macOS 27 Apple Silicon test Mac, all eight Current actions appeared
  in Shortcuts. Code, Work, and Omni mode actions executed successfully from
  the final packaged arm64 app and opened their respective modes. The other
  actions and macOS 14/Intel execution have not been individually runtime-tested.
- **Sonoma Legacy profile:** compatible core Code, Work, Omni, terminal,
  providers, connectors, security, Activity, and Notification Center remain.
  The macOS-15-only native translation, image OCR, exact-window capture, and
  HDR UI are hidden. AI translation remains a distinct non-native option.
- **Release packaging:** four architecture/profile-specific DMGs, strict
  ad-hoc code-signature and resource-seal checks, DMG verification, checksum
  files, and an aggregate release manifest. The build validates minimum-OS
  and architecture metadata for the bundled native helpers and App Intents.

## Shortcuts limitations

Ask Omni opens the Omni interface; it does not accept a Shortcuts text
parameter or return an agent answer. Translate Clipboard opens OmniCode's
native translation flow but does not return translated text to Shortcuts.
Run Workspace Tests is deliberately not exposed as an external action.
Shortcuts actions never bypass OmniCode's existing tool permissions.

## Distribution and testing

These beta installers are ad-hoc signed and **not** Developer ID signed or
notarized. macOS Gatekeeper may reject the first launch. If you trust this
download, use Finder's normal Open flow and then System Settings → Privacy &
Security → Open Anyway. Do not disable Gatekeeper system-wide. Strict
`codesign` and DMG integrity validation do not establish Apple distribution
trust. A separate Intel Mac is still needed for x64 runtime testing, and a
real macOS 14 host is needed for Sonoma Legacy runtime testing. See
`docs/platform/MACOS_SUPPORT.md` and
`docs/platform/MACOS_SYSTEM_INTEGRATION.md` for the detailed matrix.
