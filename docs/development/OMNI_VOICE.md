# Omni Voice Architecture

Last updated: 2026-09-21

Status: **Real macOS speech output is implemented and automated-verified;
microphone input, speech-to-text, and local wake activation are unavailable**

## Current repository reality

OmniCode now contains provider-neutral voice contracts and a real
`TextToSpeechProvider` in `src/main/services/omni-voice-service.ts`.
`MacOSSayTextToSpeechProvider`:

- invokes only the fixed `/usr/bin/say` executable with `shell: false`;
- sends bounded speech text over stdin rather than process arguments;
- enumerates installed macOS voices using `say -v ?`;
- validates voice identifiers and speaking rate;
- strips embedded `say` control commands and redacts credential-like text;
- bounds captured process output;
- supports AbortSignal cancellation, explicit Stop, superseding speech, and
  disposal without allowing an older utterance to become current again.

The main process exposes availability, installed-voice listing, and Stop through
typed Omni IPC. When spoken responses are enabled, the controller's safe final
result can be spoken; stopping a task also stops speech. The full Omni UI shows
real output availability and installed voice choices rather than claiming input
support.

There is still no microphone capture, concrete `SpeechToTextProvider`, partial
or final transcription, audio-input device setting, or “Hey Omni” detector.
STT and wake-word interfaces exist only as contracts and are not presented as
available providers.

The main Electron session continues to reject renderer media permission
requests. The renderer has no `getUserMedia`, `MediaRecorder`, or Web Speech
implementation, and the package has no microphone/speech-recognition entitlement
for a capturing helper. Therefore no UI may present voice **input** or wake
activation as available.

The model catalog deliberately filters audio/transcription/TTS model products
from ordinary chat selectors in `src/main/services/model-catalog-manager.ts`.
That is not a voice implementation and must not be treated as one.

## Design goals

- Voice is one input/output surface for the same main-process OmniController.
- Wake-word processing is local and never uploads continuous pre-wake audio.
- Voice capture begins only after explicit shortcut activation or a local wake
  event.
- Speech providers are replaceable; Omni is not coupled to a cloud vendor.
- Partial transcript, cancellation, interruption, and final transcript are
  first-class states.
- The helper and UI show microphone state clearly.
- Spoken output is concise and human-facing; detailed tool activity stays in
  Activity.
- No raw audio is persisted by default.

## Provider contracts

The trusted main process should own narrow interfaces similar to:

```text
SpeechToTextProvider
  capabilities() -> onDevice, streaming, supportedLocales
  start(options, signal) -> partial/final transcript events
  stop() -> final transcript or cancelled state

TextToSpeechProvider
  voices() -> bounded installed voice metadata
  speak(text, options, signal) -> started/finished/interrupted events
  stop()

WakeWordProvider
  start(model, signal) -> local wake events
  pause()
  stop()
  metrics() -> bounded CPU/false-trigger diagnostics
```

Provider implementations run in trusted main/native/helper code. The current
TTS provider runs in the main process; a sandboxed renderer receives only
availability, installed voice labels, and bounded errors. It never receives a
process handle, raw microphone frame, or direct permission handle.

## Command voice flow

```text
shortcut or local wake event
  -> stop/duck current TTS
  -> show overlay and Listening state
  -> start microphone capture
  -> emit bounded partial transcript
  -> voice activity/end-of-utterance detection or explicit Stop Listening
  -> finalize transcript
  -> discard command audio
  -> OmniController plans and briefly acknowledges
  -> tools execute through PermissionManager
  -> concise result is rendered and optionally spoken
```

The controller, not the speech provider, decides what the transcript means and
whether a task may run. Transcription text is untrusted user input and follows
the same validation limits as typed requests.

## Initial speech-to-text provider

The preferred initial implementation is a small Swift service using
`AVAudioEngine` and `SFSpeechRecognizer`:

- request microphone and Speech Recognition permissions only when the user
  enables or invokes voice;
- report `not-determined`, `granted`, `denied`, `restricted`, and unavailable
  states without pretending success;
- use `shouldReportPartialResults` for responsive transcripts;
- when the UI labels recognition as local, require on-device recognition and
  fail clearly if the selected locale/device does not support it;
- do not silently fall back from an on-device selection to a paid or cloud
  service;
- cap transcript duration and text size;
- stop the audio engine and release the device on completion, cancellation,
  screen lock, helper disable, or application shutdown.

Chromium Web Speech is not the primary provider because service availability,
network behavior, and packaged Electron support are not controlled enough for
the promised privacy boundary. A local Whisper-compatible provider can be
added behind the same interface later, but it must be measured for model size,
latency, memory, and battery before being offered.

## Text-to-speech provider — implemented

The initial implementation uses macOS's installed `/usr/bin/say` service
through a fixed-executable, no-shell process adapter. It supports installed
voice discovery, bounded rate selection, Stop, task cancellation, and immediate
supersession. Passing text on stdin plus strict argument validation prevents
model content from becoming shell or `say` command syntax.

A future native `AVSpeechSynthesizer` service may replace this provider behind
the same contract if the helper architecture needs lower-latency callbacks. It
is not required to represent the current TTS feature honestly.

Spoken content rules:

- acknowledge a meaningful task with a short public course of action;
- speak occasional meaningful updates for long tasks, not every tool call;
- speak completion or the exact blocking reason;
- never speak passwords, tokens, API keys, cookies, authorization headers,
  private keys, or content marked sensitive;
- do not read a long terminal log, email body, webpage, or document unless the
  user explicitly requested it;
- honor Voice Responses Off immediately.

Starting another utterance stops and supersedes the current speech generation;
an older completion cannot clear the new active utterance. A future microphone
activation must stop or duck TTS before capture begins.

## “Hey Omni” wake phrase

Wake activation is optional and defaults to off. Settings are:

- Off
- Shortcut only
- Hey Omni + shortcut

A real local detector is required before the third option can be enabled. The
repository currently has no engine/model, so this is an implementation and
verification gate, not a CSS/settings-only task.

The local wake provider must:

- run in the lightweight signed helper, not a visible renderer;
- use a bundled, licensed, architecture-compatible model;
- process low-bandwidth frames locally;
- keep only a short in-memory rolling buffer when technically needed;
- discard pre-wake frames and never add them to logs/history;
- make no network requests before activation;
- expose a visible microphone indicator and Pause Wake Word action;
- stop on user disable, logout, screen lock where appropriate, or helper exit;
- avoid running a general speech recognizer or large local model while idle.

Before enablement, onboarding must explain that the microphone is locally
monitored for the phrase, ordinary transcription starts only after activation,
and the setting can be disabled at any time.

## Privacy and data lifetime

| Data | Allowed lifetime | Persistence |
| --- | --- | --- |
| Pre-wake PCM frames | Minimum rolling detection window | Never |
| Activated command audio | Until final transcript/cancel | Never by default |
| Partial transcript | Current activation | No history until finalized |
| Final user transcript | According to Omni chat-history setting | Bounded, redacted where required |
| Spoken response text | Existing safe response/task history | No separate voice log |
| Voice/locale/speed settings | User preference | Private validated global settings |
| Provider diagnostics | Bounded status/error category | Never raw audio or secrets |

Temporary audio or model files must not be placed in a workspace. If a local
engine requires a temporary file, it must live under private application data,
use restrictive permissions, and be deleted on success, cancellation, crash
recovery, and startup cleanup.

## Permissions and packaging

Voice requires:

- `NSMicrophoneUsageDescription`;
- `NSSpeechRecognitionUsageDescription` for Apple Speech;
- the hardened-runtime audio-input entitlement for every process that captures
  microphone audio;
- signed nested helper/native code with stable identities.

Do not broadly allow `media` permission in `session.defaultSession`. Native
capture is preferred. If a future trusted renderer needs media, grant only the
exact audio request from the exact Omni surface and continue rejecting camera,
screen, managed-browser, iframe, and remote-origin requests.

The helper architecture and login lifecycle are documented in
`OMNI_BACKGROUND_SERVICE.md`.

## User-visible states and errors

The voice subsystem maps native/provider state to:

- Idle
- Listening
- Transcribing
- Speaking
- Interrupted
- Permission Required
- Unavailable
- Failed

Examples of honest errors:

- “Microphone permission is disabled. Open System Settings to enable it.”
- “On-device speech recognition is unavailable for this language.”
- “The microphone is in use by another application.”
- “Wake phrase detection stopped because the helper exited.”

No generic “Listening” state may be shown until audio capture has actually
started.

## Settings

The global main-process settings store currently validates:

- installed TTS voice identifier;
- speaking speed within a safe bounded range;
- spoken responses on/off;
- activation mode;
- local-only wake-processing policy metadata.

Voice input device, recognition provider/locale, and a usable wake enablement
setting await the corresponding concrete providers.

The helper receives only the settings it needs. It never receives provider API
keys or OAuth tokens.

## Test gates

### Automated

Passing TTS coverage verifies availability, installed-voice parsing and bounds,
fixed executable/no-shell invocation, stdin text, invalid voice/rate rejection,
redaction, embedded-command removal, provider failures, AbortSignal
cancellation, explicit Stop, concurrent speech supersession, and disposal.
`/usr/bin/say -v ?` was also invoked on the host to verify the real installed
voice format used by the parser. The current complete serial run passed 66
files with 562 tests and one intentionally skipped native-Keychain file/test. A
built-app live smoke queried the real TTS availability and installed macOS voice
list through the production preload/main-process route.

Permission-state mapping, partial/final transcript ordering, capture cleanup,
STT interruption, and helper/wake behavior remain untestable because those
providers do not exist yet.

### Packaged real-world

- microphone grant, denial, revocation, and restart;
- a real spoken “what time is it?” task;
- partial and final transcript accuracy in a quiet room;
- Stop Listening and task Stop;
- TTS voice/speed/off settings;
- user interruption while Omni speaks;
- activation from foreground, background, minimized, and another Space;
- wake enabled/disabled behavior;
- false-activation and idle-resource soak;
- network observation proving no pre-wake upload;
- screen lock/unlock and audio-device removal;
- Intel and Apple Silicon helper/native slices.

## Current blockers

- No native microphone/speech-to-text bridge exists.
- No local wake-word engine/model has been selected, licensed, bundled, or
  measured.
- Developer ID signing/notarization is unavailable on the current build host;
  stable public TCC/helper verification therefore remains blocked.
- Apple Silicon native execution still requires matching hardware testing.

Voice input and wake activation remain marked unavailable until their real tests
pass. macOS speech output may be described as available within the current
fixed-executable provider limits; a packaged audible settings/task workflow is
still required for release completion.
