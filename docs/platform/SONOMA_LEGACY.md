# Sonoma Legacy support policy

OmniCode Sonoma Legacy keeps the shared Code, Work, and Omni experience
available on macOS 14.0. It is not a separate source fork and uses the same
0.1.2 product version, storage schema, OAuth/Keychain model, PermissionManager,
connectors, local AI, and conversation persistence as Current OmniCode.

Legacy generally receives critical bug fixes, security fixes, compatibility
fixes, and shared-core improvements that remain compatible with macOS 14. It
does not automatically receive new native integrations that require macOS 15+.
For this release, Apple Translation, Swift Vision's modern image-text request,
and targeted ScreenCaptureKit snapshot actions are hidden. The existing AI
translation path is still available when the user chooses it, but an explicit
Local/System Translation request must never silently become a cloud call.

The Legacy native feature helper is deliberately an inert 14.0-targeted stub.
The speech and cursor helpers are also compiled with a 14.0 deployment target.
Core Spotlight metadata indexing and lexical query use the macOS 14-compatible
native addon. The Legacy App Intents extension is 14.0-targeted and includes
seven navigation-oriented shortcuts; it omits the on-device Translate
Clipboard action. Ask Omni currently opens Omni Mode and does not yet return
an agent answer to Shortcuts. See `MACOS_SYSTEM_INTEGRATION.md` for the exact
scope and privacy behavior.
Settings → macOS Platform and the small title-bar label identify the Legacy
profile without overwhelming the interface. Unknown future settings should be
ignored safely by the existing settings parsers; do not introduce a
Legacy-only persistence format.

Cross-building and passing codesign/DMG checks is **build verification**, not
runtime verification on Sonoma. Complete `docs/testing/SONOMA_LEGACY_TEST_CHECKLIST.md`
on a real macOS 14 machine before advertising runtime compatibility.
