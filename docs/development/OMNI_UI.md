# Omni Voice-First UI

Last updated: 2026-09-22

## Purpose

Omni's main surface is an operating console for a voice-first assistant. It is
not a second Code dashboard and it does not permanently expose every controller
record. The trusted main process remains authoritative; the renderer projects
bounded state and sends typed IPC requests.

## Primary dashboard

The surface in `src/renderer/src/components/omni/OmniMode.tsx` has four primary
regions:

1. The top command bar selects the real provider, discovered model, Invisible
   or ready Cursor execution, and approval policy.
2. The left context column identifies Omni and shows the current task plus
   Pause/Resume/Stop controls when relevant.
3. The central Omni Core projects Idle, Listening, Transcribing, Planning,
   Approval, Working, Cursor, Speaking, Paused, Completed, Failed, and Stopped
   state. Its motion is decorative; controller state remains authoritative.
4. The right Activity timeline renders the newest bounded, redacted task events
   and concise safe summaries.

The bottom voice dock starts/stops real push-to-talk sessions. The captured
transcript is sent as a task only after the user stops the dashboard session.
Setup microphone tests never create a task.

## Deliberately secondary UI

- Previous tasks open in a drawer.
- Typed requests are hidden by default and appear only when `showTextInput` is
  enabled in Settings → Omni.
- Course of Action and permanent Availability panels were removed from the
  primary dashboard. Plans, task records, permissions, and capabilities still
  exist in their trusted backend owners.
- Raw provider/tool errors are mapped to actionable user copy. Technical detail
  is available behind a disclosure and remains sanitized.

## State and safety rules

- A disabled Omni setting disables both microphone and typed task submission.
- A running task locks the active approval policy and prevents a second task.
- Cursor is selectable only when the native helper, Accessibility permission,
  and emergency stop are ready.
- Microphone and speech status are never inferred from the presence of a UI
  control; the renderer uses main-process capability snapshots.
- Provider/model controls use the same catalog as the existing AI systems.

## Visual system

`OmniMode.css` uses a deep navy surface, cyan/blue accents, restrained green and
red status colors, fine grid texture, CSS waveform lines, and CSS-transform
orbital animation. No copied visual assets or screenshot fragments are used.

Continuous animation is disabled by `prefers-reduced-motion: reduce`. The
dashboard changes from three columns to two and then one as space narrows. At
960×600 the secondary context column scrolls internally; at 720×720 the panels
stack without horizontal overflow.

## Verification

`scripts/audit-omni-ui.mjs` launches against production output and verifies:

- the dashboard contains the Core, microphone, four real selectors, and
  Activity while omitting permanent Course/History/Availability panels;
- typed input defaults off and, when enabled, is visible inside the dock and
  viewport;
- 960×600 and 720×720 layouts have no horizontal overflow and retain the Core
  and Activity;
- Reduce Motion removes orbit and microphone animation;
- setup and input preferences persist;
- no renderer error is logged.

The 2026-09-22 fresh-profile audit passed every assertion and screenshots were
manually inspected.
