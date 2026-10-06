# Omni Voice Architecture

Last updated: 2026-10-04

Status: **Deterministic push-to-talk, live partial transcripts, Auto/Enter
finalization, device diagnostics, and real on-device Apple Speech wiring are
implemented and exercised with the system-default AirPods microphone in an
unlocked graphical session. Wake-word activation remains unavailable.**

## 2026-10-01 live acceptance evidence

- macOS reported `Shresht’s AirPods` as the Bluetooth system-default input;
  the active `AVAudioEngine` capture format was 48,000 Hz, mono.
- Microphone and Speech Recognition permissions were both granted. The real
  `en-US` request reported on-device requested, supported, and active.
- Auto mode preserved a time request through seven partials and finalized once
  after 1.713 seconds of silence. A longer multi-clause request produced 22
  partial updates over 11.724 seconds and finalized once after 1.676 seconds.
- Press Enter mode waited through 3.886 seconds of silence, then finalized only
  when Enter was pressed. Auto-mode Enter override finalized after 903 ms of
  silence, before the automatic threshold, without a later duplicate submit.
- A 12.042-second no-speech Auto session timed out without creating an AI task.
  Empty Enter sessions likewise created no task and showed the retry UI.
- More than five consecutive sessions used unique IDs, released their helper
  processes, carried no stale transcript, and produced no duplicate model
  submission. Real standalone TTS enumeration, interruption, and completion
  also passed.
- Manual AirPods disconnect during an active capture and a frame-by-frame
  recording of the partial-text animation remain unperformed. The observed
  partial counts and final task text prove the native streaming path, but model
  or tool quality is reported separately from transcription quality.

## Current implementation

Voice is an input surface for the existing `OmniController`; it is not a
separate agent. A successful session follows this path:

```text
Cmd+Shift+Space
  -> compact Omni overlay
  -> signed omnicode-speech-helper.app bundle
  -> AVAudioEngine system-default input
  -> SFSpeechRecognizer partial results
  -> sustained silence or temporary Enter shortcut
  -> stop audio + endAudio()
  -> final transcript
  -> existing OmniController / selected provider / ToolRegistry
  -> result
  -> optional System Voice or ElevenLabs text-to-speech
```

The renderer never receives raw audio or native process handles. The helper
emits bounded amplitude, state, partial-transcript, final-transcript, and safe
diagnostic events over newline-delimited JSON. Audio is not written to disk.

## Session state machine

`OmniVoiceSessionMachine` is the main-process lifecycle guard for one spoken
request. Shared user-facing states are:

```text
IDLE
STARTING
LISTENING
SPEECH_DETECTED
WAITING_FOR_END
FINALIZING_TRANSCRIPT
THINKING
WORKING
SPEAKING
COMPLETED
CANCELLED
FAILED
```

The native helper owns the capture-side states through transcript finalization.
The existing Omni task and speech-output events drive Thinking, Working, and
Speaking in the overlay after submission. `finalizeOnce()` ensures Enter,
silence, a Speech-framework final result, and timeout cannot produce more than
one finalization or model submission.

The overlay does not add transcript approval or per-step approval controls.
Existing security-sensitive tool approvals remain owned by the existing
permission architecture.

## End-of-speech behavior

Settings expose two modes under **Settings → Omni → Voice → Finish speaking**:

- **Automatically** (default): allow 12 seconds for speech to begin, then
  finalize after configurable sustained silence (default 1.6 seconds; supported
  range 1.2–2.5 seconds).
- **Press Enter**: continue listening through pauses until Enter is pressed,
  subject to the five-minute safety cap.

Enter is also an immediate finish override in Automatically mode. Escape
cancels and discards the transcript. Electron global shortcuts for Enter and
Esc are registered only after native capture is ready and are removed as soon
as finalization or cancellation begins. They do not remain active outside a
voice session.

The native endpoint detector uses both actual microphone energy and recognition
activity:

- it first establishes a bounded adaptive noise floor;
- energy must remain above the voice threshold long enough to count as speech;
- a non-empty partial result also proves speech began;
- sub-300 ms quiet periods only move the UI toward Waiting for End;
- only sustained quiet matching the configured delay finalizes Auto mode;
- initial silence never sends an empty prompt.

There is one 100 ms endpoint monitor, rather than unrelated timers competing to
submit the request.

## Partial and final transcripts

`SFSpeechAudioBufferRecognitionRequest.shouldReportPartialResults` is enabled.
Each partial replaces the prior partial in the compact overlay, so recognition
corrections do not appear as duplicate messages. The transcript area wraps,
keeps a fixed maximum height, and scrolls to the newest text instead of growing
the overlay.

Finalization uses this order:

```text
stop accepting microphone buffers
  -> stop AVAudioEngine and remove its tap
  -> call recognitionRequest.endAudio()
  -> keep the recognition task alive for a final result
  -> use the final transcript (with a 2.5 second fallback)
  -> clean up recognition objects
  -> submit non-empty text once
```

This prevents the last word from being cut off, particularly on Bluetooth
routes. Empty Auto timeouts show “No speech detected.” Empty Enter submissions
show “I didn’t hear anything.” Neither starts an AI request.

## Audio devices and AirPods

The helper queries CoreAudio for the current system-default input and reports:

- device name;
- transport (including Bluetooth/Bluetooth LE);
- capture sample rate;
- input channel count.

Settings show an honest disabled selector labelled **System Default —
&lt;device&gt;**. OmniCode does not pretend it can select a device that
`AVAudioEngine` was not configured to select. Starting a new session follows
the then-current macOS default input, including AirPods connected after
OmniCode launched.

During capture, the helper observes both the CoreAudio default-input property
and `AVAudioEngineConfigurationChange`. A removed device, changed route, zero
channel format, sample-rate change, or channel-count change fails the session
with “Microphone disconnected or changed. Try the voice request again.” The
next activation creates a fresh engine and follows the new default route.

Bluetooth is given extra final-result time after `endAudio()`; capture does not
use partial-result timing alone as a silence signal. A real AirPods session must
still verify actual startup latency, partial latency, format, and endpoint
tuning on the target Mac.

## On-device recognition and permissions

`MacOSSpeechToTextProvider` always starts recognition with
`requireOnDevice: true`. The helper checks
`supportsOnDeviceRecognition` before capture and sets
`requiresOnDeviceRecognition = true` on the real request. It fails closed if
the selected locale cannot run on device; there is no silent cloud fallback.

“Available” in Settings means the API reports support. “Active” is shown only
after a real capture session returns diagnostics confirming on-device mode was
requested, supported, and active. Support alone is not recorded as a completed
on-device test.

The native speech-helper app bundle carries an `Info.plist` with:

- stable identifier `com.omnicode.editor.speech-helper`;
- `NSMicrophoneUsageDescription`;
- `NSSpeechRecognitionUsageDescription`.

It is then signed with the narrow audio-input entitlement and hardened-runtime
option. This gives the helper a stable privacy identity and ensures development
permission requests do not depend on the stock Electron development bundle’s
plist. Packaged OmniCode also carries both usage descriptions in the outer app
plist. The separate helper bundle identity is important for stable macOS
privacy permissions.

Microphone and Speech Recognition requests still use the established
`MacOSPermissionManager`. Denied/restricted states point to System Settings and
are not repeatedly re-prompted or bypassed.

## Native helper lifecycle and signing

`scripts/build-omni-speech-helper.mjs`:

1. validates the helper plist with `plutil`;
2. compiles Swift for `OMNICODE_TARGET_ARCH` (`arm64` or `x86_64`) with
   AVFoundation, CoreAudio, and Speech;
3. copies the helper `Info.plist` into the app bundle and applies executable permissions;
4. ad-hoc signs the helper with hardened runtime and the audio-input
   entitlement.

The macOS packaging scripts copy the helper to
`Contents/Resources/omni-native`, restore its narrow signature after
electron-builder’s recursive signing pass, and reseal the outer app last.
`validate-macos-build.mjs` verifies architecture, strict code signing, stable
helper identity, bundled privacy keys, and the audio-input entitlement.

Ad-hoc signing is still local diagnostic distribution, not Developer ID
signing or notarization. Stable public Gatekeeper/TCC behavior remains a release
gate until a Developer ID identity and notarization are available.

## Text-to-speech

`MacOSSayTextToSpeechProvider` invokes only `/usr/bin/say` with `shell: false`,
sends bounded redacted text through stdin, validates voice/rate arguments,
supports cancellation and supersession, and never allows model text to become
shell syntax. Voice input first stops current TTS to avoid capturing Omni’s own
response. `OmniSpeechOutput` now selects this System Voice provider or optional
ElevenLabs output. ElevenLabs audio is streamed as PCM into the existing signed
native helper without temporary audio files. Connection, voice browsing,
preview, Keychain storage, speech chunking, fallback, and live-test limits are
documented in [OMNI_ELEVENLABS.md](./OMNI_ELEVENLABS.md).

## Privacy and diagnostics

The helper records no audio. The model normally receives only the finalized
text. Partial transcripts are current-session UI state and are not persisted as
separate history items.

Development diagnostics contain only session ID, input-device name/transport,
sample rate, channel count, locale, on-device requested/supported/active flags,
duration, speech-start offset, final-silence duration, partial-result count,
and finalization reason. Full transcript text and microphone audio are not
written to diagnostics.

## Automated coverage

Focused tests cover:

- legal and illegal state transitions;
- partial transcript correction/replacement protocol;
- Enter, silence, timeout, cancellation, and Speech-framework final reasons;
- one-winner finalization races;
- empty cancellation without a submit-worthy transcript;
- startup failure recovery and five rapid consecutive sessions;
- microphone-route/helper failure propagation;
- device and on-device diagnostics;
- finish-mode and silence-delay settings validation/migration;
- permission not-determined, denied, and refresh behavior;
- temporary session cleanup;
- helper privacy/signing build configuration;
- existing TTS interruption, redaction, argument validation, and cleanup.

The physical Speech framework, actual partial text, audio energy, and Bluetooth
timing cannot be honestly proven by mocked tests.

## Required real acceptance tests

Run these in an unlocked graphical macOS session with the desired AirPods shown
as the real system-default input:

1. grant Speech Recognition when macOS prompts;
2. Auto: speak “What time is it on this Mac?” with a short natural pause;
3. Enter mode: pause several seconds, confirm no auto-submit, then press Enter;
4. Auto Enter override before silence fires;
5. longer multi-clause request with pauses and visible evolving partial text;
6. Auto initial-silence timeout and empty Enter;
7. five consecutive sessions with no stale text, recognizers, shortcuts, or
   duplicate submissions;
8. an actual Omni tool request and optional TTS response;
9. manual AirPods disconnect/input-route change during capture.

Record transcription and agent outcomes separately. A model/tool failure does
not prove speech recognition failed, and a correct transcript alone does not
prove the agent result succeeded.

## Known limitations

- Wake-word/“Hey Omni” support is still unavailable; no licensed local wake
  model is bundled.
- Device selection is system-default only.
- Ad-hoc builds are not notarized public releases.
- An x86_64 helper can be cross-compiled and signature-verified on Apple
  Silicon, but cannot be executed without Rosetta or an Intel Mac.
- The 2026-10-01 ARM64 and x64 0.9.0 diagnostic DMGs include this voice change
  and pass strict nested-signature, architecture, mounted-image, and checksum
  validation. They remain ad-hoc signed and unnotarized.
