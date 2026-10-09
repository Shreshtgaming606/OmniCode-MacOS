# OmniCode Project Instructions

## macOS release profiles

Current OmniCode targets macOS 15+; Sonoma Legacy targets macOS 14 from the
same source tree. For each new native macOS feature, verify Apple's minimum OS,
implement the best Current version, choose a real Sonoma fallback/reduction or
hide it, add capability tests, and document the difference. Do not duplicate
Code/Work/Omni business logic or weaken Keychain, OAuth, or permissions in Legacy.
Never describe cross-built Sonoma artifacts as runtime-tested without macOS 14.

## End-of-task cleanup

After substantial development, testing, packaging, or release work, clean up before the final response:

- Inventory OmniCode application bundles and mounted OmniCode disk images created or affected by the task.
- Remove obsolete generated `OmniCode.app` bundles, temporary test/quarantine copies, stale build directories, and safe-to-remove LaunchServices registrations.
- Detach temporary OmniCode DMGs that are no longer in use.
- Preserve the source repository, credentials, the latest validated release DMGs and checksums, and any artifact or log needed to diagnose a current unresolved failure.
- Do not remove `/Applications/OmniCode.app` while the user is actively testing it unless a clean reinstall is an explicit next step.
- Never delete source code, credentials, or unresolved-failure evidence as part of routine cleanup.
- Verify remaining application locations with filesystem and Spotlight searches after cleanup.

End the final response with a `CLEANUP STATUS` section listing stale apps removed, DMGs detached, temporary artifacts removed, any installed app, current ARM64 and x64 installer paths, intentionally preserved evidence, and all remaining `OmniCode.app` locations.
