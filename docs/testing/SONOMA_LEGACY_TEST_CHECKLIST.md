# Sonoma Legacy manual acceptance checklist

Test each architecture on real macOS 14 hardware or a properly configured
Sonoma virtual machine. Record build SHA-256, OS patch version, hardware,
permissions, and actual results. Do not mark a row passed based on a cross-build.

- [ ] Install the correct `Sonoma-Legacy` DMG on macOS 14; verify app launches.
- [ ] Confirm About/Settings says Sonoma Legacy, minimum 14.0, actual OS and architecture.
- [ ] Open/save/rename a Code workspace, edit in Monaco, run a harmless file,
      use terminal/`node-pty`, local server, and Git status.
- [ ] Run a local Ollama Code task and verify Activity/Notification persistence.
- [ ] Run a safe Work conversation and Managed Browser read. If test account is
      available, connect Gmail/Drive and perform read-only search.
- [ ] Exercise Omni typed request, local voice partial/final transcript,
      on-device Speech status, TTS, overlay shortcut, and Cursor safe action.
- [ ] Verify Apple Translation, modern Vision OCR, and targeted window capture
      are hidden and do not run macOS-15-only code.
- [ ] Confirm permission request/deny/retry behavior without TCC manipulation.
- [ ] Upgrade a Legacy profile to Current on macOS 15+ and confirm settings,
      conversations, workspaces, and Keychain credentials persist.
- [ ] If downgrading for test, confirm unknown Current settings do not crash Legacy.
- [ ] Verify strict codesign, DMG integrity, mounted app equivalence, and no
      post-seal mutation independently on arm64 and x64 artifacts.

Current status: **not run on Sonoma hardware**. Cross-build validation alone
must not be reported as Sonoma runtime success.
