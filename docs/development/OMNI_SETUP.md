# Omni First-Time Setup

Last updated: 2026-09-22

## Entry and persistence

Omni setup appears when the private global `OmniSettings.setupCompleted` value
is false. It is independent of OmniCode's general application onboarding.
Completing the final step atomically persists `setupCompleted: true` and enables
Omni. Settings → Omni → Rerun Setup & Permissions resets only this gate; it does
not erase credentials, history, or unrelated application settings.

Older version-1 Omni settings documents migrate missing `setupCompleted` and
`showTextInput` fields to false without resetting valid existing preferences.

## Seven steps

1. **Welcome** explains the existing Code, Work, approved automation, and voice
   capabilities without claiming unavailable access.
2. **Permissions** displays the real main-process macOS snapshot for microphone,
   speech recognition, Accessibility, screen recording, automation, and files.
   Grant/open-settings actions use the existing permission APIs; focus return
   refreshes the snapshot.
3. **Voice** exercises the real push-to-talk session and local TTS route. Voice
   list/rate use the same validated global settings.
4. **AI** selects a real existing provider and a model from the provider catalog.
   No model is fabricated and no API key is exposed to the renderer.
5. **Execution** selects Invisible or genuinely ready Cursor mode and the real
   approval policy. Full Access still uses the existing acknowledged warning and
   main-process enforcement.
6. **Activation** configures the existing shortcut/wake preference and login
   background setting. Unsupported local wake behavior is not presented as a
   verified running engine.
7. **Ready** summarizes actual permission, model, shortcut, execution, and
   approval readiness. Missing optional permissions are shown as needing
   attention; they do not become fake successes.

## Permission and voice boundaries

The renderer does not receive media devices or Node access. Microphone capture
is owned by the fixed-protocol Swift helper through the main process. Only
bounded text events cross IPC; raw audio is not persisted. If the required
on-device Speech asset or permission is unavailable, setup gives a real status
and Omni remains usable through an explicitly enabled typed fallback.

## Settings surface

Settings → Omni provides General, Voice, Activation, AI, Execution, Approvals,
Input, Permissions, Privacy, and Activity sections. It supports real voice
testing, permission refresh, provider/model selection, the `Show text input`
toggle, and setup rerun. All writes use `omni:settings:update`; the renderer does
not write preferences directly.

## Verification

The fresh-profile production audit advances every step using the same rendered
controls as a user, verifies all seven progress items, footer visibility, no
horizontal overflow, setup persistence, and zero renderer errors. Unit tests
cover defaults, concurrent updates, legacy migration, setup rendering, Settings
navigation, and friendly error presentation.
