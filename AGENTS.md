# OmniCode Project Instructions

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
