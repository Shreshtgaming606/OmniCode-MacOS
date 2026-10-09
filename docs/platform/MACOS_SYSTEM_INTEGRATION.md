# macOS system integration (0.1.1)

OmniCode uses one Code/Work/Omni runtime for both release profiles. Current
targets macOS 15+; Sonoma Legacy targets macOS 14. The native Spotlight addon
and App Intents extension are built separately for each architecture and
profile, then sealed into the same Electron app. They do not hold OAuth tokens
or duplicate OmniCode's agent and connector logic.

## Core Spotlight

`spotlight-manager.ts` is the sole owner of OmniCode's `OmniCodeMetadata` Core
Spotlight index. A small Objective-C++ addon executes Core Spotlight APIs in
the signed Electron main process. The main process obtains the recent
workspaces and eligible Work conversation titles from existing persistence,
coalesces changes, compares against the last indexed snapshot, and indexes or
deletes only changed OmniCode records. A startup sync and Settings → Rebuild
OmniCode Index recover from ordinary app updates. Settings → Clear OmniCode
Index removes only this app's index domain and turns indexing off. The system's
other Spotlight content is untouched.

Default-on items are recent workspace **names**, eligible Work conversation
**titles**, and fixed OmniCode action names. Workspaces use opaque UUIDs;
absolute paths remain in a private local mapping, not in Spotlight metadata.
Workspace file contents, filenames, prompts, answers, terminal output, Gmail
and Drive bodies, tokens, cookies, browser pages, and hidden reasoning are not
indexed. Work conversations marked as containing connected-app data are
excluded. Basic secret-pattern and path screening suppresses suspicious
titles. Since titles are user-authored and Spotlight is a system index, users
can disable conversation titles or all indexing; do not put secrets in titles.
Saved workflows and filename indexing remain off because there is no safe,
stable workflow metadata source or per-file indexing lifecycle yet.

Search uses `CSUserQuery`. Current requests permit the macOS 15 semantic search
option; Legacy disables it and keeps lexical search. Apple's index and ranking
decide which results appear. A related-word match is not guaranteed. On this
development Mac a lexical query returned test workspace/conversation metadata,
but one related-word probe did not return the workspace; this is not claimed as
a validated semantic match. Real Spotlight GUI clicks, indexing-rebuild
requests from the OS, and behavior on macOS 14 still require separate tests.
No `CSIndexExtensionRequestHandler` is included yet; Settings rebuild and
startup reconciliation are the currently implemented recovery mechanisms.

## Navigation and Shortcuts

Spotlight identifiers resolve through an allowlisted main-process router.
`omnicode://` supports opaque workspace IDs, Work conversation IDs, Code/Work/
Omni mode navigation, and a small set of fixed actions. It rejects query
strings, fragments, encoded components, traversal, unknown actions, and raw
filesystem paths. Workspace IDs must still be present in recent-workspace
history; conversation IDs must still exist. URLs never grant workspace access
or bypass the existing tool permissions.

The signed, sandboxed `OmniCodeIntents.appex` supplies App Intents actions to
macOS Shortcuts. Its execution path invokes allowlisted navigation URLs; actual mode,
voice, workspace, and translation behavior stays in OmniCode. Both profiles
include Open Code Mode, Open Work Mode, Open Omni Mode, Start Omni Voice, Ask
Omni, Open Workspace (opens a folder picker), and Open Recent Workspace
(selects the most recent authorized folder or opens a picker). Current alone
includes Translate Clipboard, which opens the existing on-device translation
flow and asks for source/target language codes. Legacy omits that shortcut.

**Limitations:** Ask Omni currently opens the Omni interface but does not pass
a Shortcuts text parameter, run the agent, or return a result to Shortcuts.
Translate Clipboard does not return translated text to Shortcuts. There is no
Run Workspace Tests intent because invoking a repository's `npm test` from an
external URL could execute arbitrary package scripts without an appropriate
trusted intent channel. These actions must not be represented as fully
implemented automations. They also do not elevate PermissionManager authority.

**Runtime repair:** A `swiftc` executable hand-wrapped as an `.appex` registered
with PlugInKit but crashed in ExtensionFoundation before `perform()` when
Shortcuts launched it. `build-omni-intents.mjs` now builds a real Xcode
app-extension target and includes Xcode's generated App Intents metadata.
On the macOS 27 Apple Silicon test Mac, all eight Current actions were listed,
and running Code, Work, and Omni mode actions from Shortcuts opened the
final packaged Current arm64 test app in the matching mode without the helper
error. The preinstalled 0.9.0 OmniCode app has the same
bundle ID and initially masked the newer test app in Shortcuts; unregistering
only that stale LaunchServices entry restored discovery. Other individual
actions, x64, and macOS 14 require their own runtime tests;
the latter two must not be described as runtime-validated from this Mac.
Apple's macOS terminology is **App Intents actions in Shortcuts**, not
automatic App Shortcuts suggestions.

The extension's `com.apple.security.app-sandbox` entitlement is required for
macOS plug-in registration. The repaired packaging flow signs the extension
with that narrow entitlement, signs native helpers, and finally reseals the
outer app; no file is changed after the final seal. Ad-hoc signatures do not
provide Developer ID trust or notarization.

## Testing

Run `npm run typecheck`, `npm test`, and `npm run release:mac`. The release
validator checks the extension metadata, sandbox entitlement, architecture,
minimum OS, strict signatures, and each mounted DMG. On an unlocked graphical
Mac, search Spotlight for a unique test workspace and conversation and click
each result; confirm the exact item opens. In Shortcuts, search OmniCode's
action library and run navigation, workspace-picker, and Current translation
actions. Clean the temporary index entries and test app afterward. Cross-built
x64 and Sonoma artifacts are **not** runtime-tested by building on this arm64
macOS 27 machine; use an Intel Mac and a real macOS 14 host for those claims.

Apple references: [Core Spotlight indexes](https://developer.apple.com/documentation/corespotlight/adding-your-app-s-content-to-spotlight-indexes),
[search queries](https://developer.apple.com/documentation/corespotlight/building-a-search-interface-for-your-app),
[index regeneration](https://developer.apple.com/documentation/corespotlight/regenerating-your-app-s-indexes-on-demand),
and [App Shortcuts](https://developer.apple.com/documentation/appintents/app-shortcuts).
