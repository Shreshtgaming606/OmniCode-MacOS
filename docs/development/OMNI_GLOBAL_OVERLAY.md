# Omni Global Voice Overlay

Last updated: 2026-09-23

## Implemented experience

`⌘⇧Space` reuses the resident main-process shortcut owner and one lazily created
overlay window. The window is a 320×248 borderless, fixed-size, translucent
floating surface positioned 18 points inside the top-right of the work area for
the display nearest the cursor. It is visible over full-screen Spaces where
macOS permits and uses `showInactive()` so activation does not take keyboard
focus from the foreground application.

The renderer is deliberately voice-only. It contains:

- Omni identity and close/open-full-Omni controls;
- amplitude-driven cyan/blue/violet waveform;
- Listening, Understanding, Working, Speaking, Done, permission, and failure
  states;
- a bounded three-line live transcript or concise spoken/status summary;
- contextual Enable/Open Settings, Retry, and separate Stop Task actions.

It does not contain a textarea, model/provider settings, execution or approval
selectors, Course of Action, Current Step, Activity timeline, history, or tool
logs. Those stay in full Omni Mode.

## Lifecycle

1. The main process selects the active display by cursor location, positions the
   existing singleton window, shows it inactive, and sends one activation event.
2. If a task is already running, the overlay displays only its high-level state.
   Otherwise it checks microphone and speech authorization and begins local
   voice input.
3. Native microphone RMS is normalized and emitted at most about 20 times per
   second. Only the amplitude scalar and bounded transcript cross IPC; audio is
   never returned or persisted.
4. A final transcript starts the existing `OmniController`. The existing public
   plan summary—not hidden reasoning—is spoken before tool execution.
5. Tool events are collapsed to safe phrases such as “Working in the browser”
   or “Running a command.” Detailed activity remains in full Omni.
6. Completion speech and a short result remain briefly, then the overlay
   dismisses. It does not dismiss while listening, speaking, working, waiting
   for permission, or showing a failure.

Closing while listening cancels capture. Closing during a task hides the
surface but does not terminate work; Stop Task is separate. Escape performs the
same interaction cancellation when the overlay itself has focus. The existing
global Cursor emergency stop remains independent.

## Security and performance

The overlay retains its separate sandboxed renderer and capability-limited
preload. It cannot directly access filesystem, terminal, Git, credentials,
connectors, browser, or native cursor APIs. Navigation and new windows are
denied. It reuses the controller, tool registry, permission system, provider
manager, voice service, and task stores rather than loading a second AI stack.

CSS honors Reduce Motion and Reduce Transparency. The waveform stops decorative
motion under Reduce Motion while retaining status. No duplicate overlay window
is created.
