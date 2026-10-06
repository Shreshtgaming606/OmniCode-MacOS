# Omni Mode: optional ElevenLabs speech output

Last updated: 2026-10-04

Omni keeps macOS System Voice as the default. ElevenLabs is an optional,
user-supplied text-to-speech service; it does not replace the on-device macOS
speech recognizer used for microphone input.

## Connect and choose a voice

Open **Settings → Omni → Voice**, paste an ElevenLabs API key, and select
**Connect**. Omni validates the key with the read-only account voice-list
endpoint before saving it. The key is stored only as the `api-key` item in the
macOS Keychain service `com.omnicode.editor.elevenlabs`; it is not written to
Omni settings, the repository, or conversation history. The key field clears
after a connection attempt. Disconnect removes only that Keychain item and
switches output back to System Voice.

After connecting, the voice browser loads the account's current voices,
including available custom voices, from ElevenLabs. Search by name or voice
metadata, press **Preview** to hear a short fixed phrase, then **Use voice**.
The selected voice ID, model ID, voice controls, provider, and fallback choice
are non-secret preferences saved in Omni's local settings. **Preview changes**
uses the draft controls; **Save voice** persists them. Previews are generated
only when clicked and may count toward the user's ElevenLabs plan.

The model list comes from ElevenLabs' TTS-compatible model catalog. Controls
are shown only where supported: stability; similarity where supported; style
where reported and supported; and speed for the supported v2 family. The app
omits unsupported fields from speech requests. The normal default preference
is the low-latency Flash v2.5 model when the account offers it; otherwise the
first compatible model is used until the user chooses one.

## Speech path and privacy

Only prepared text Omni is about to speak is sent to ElevenLabs. Omni does not
send microphone audio, raw tool payloads, workspace files, OAuth tokens, or
conversation history as separate inputs to this TTS integration. If the final
spoken answer itself quotes sensitive material, that text may be sent; Omni
redacts common credentials and omits private reasoning markers, code fences,
URLs, and other non-spoken formatting before synthesis. Users should still
avoid asking Omni to read secrets aloud.

For chat-only answers, completed sentences are queued in order as the model
streams its answer. Tool-planning turns use only the completed user-facing
answer. Each sentence is synthesized through ElevenLabs' streaming endpoint
as 24 kHz mono signed PCM. A signed macOS native helper plays streamed PCM
from stdin through AVAudioEngine, without writing an audio file. New voice
sessions, Stop, and preview changes abort requests and stop playback. When
**Fallback to System Voice** is on (the default), an ElevenLabs error switches
the current answer to macOS speech; remaining queued sentences use System
Voice without repeated ElevenLabs retries.

The in-app text response remains available even when speech fails. The
overlay uses its existing Speaking state. No new approvals are added.

## Verification

Normal `npm test` mocks the ElevenLabs API and never consumes voice credits.
The opt-in live integration test requires a valid key already connected in
Omni, a built speech helper, an unlocked audio-capable macOS session, and
`OMNICODE_TEST_ELEVENLABS=1`. It fetches live voices/models and generates one
short preview. It verifies that native playback starts, but a human must
listen to confirm audible output and test the full microphone → Omni agent →
ElevenLabs path in the GUI.

An invalid or expired key cannot be used for live previews. Do not treat mock
tests or a helper-only PCM smoke test as proof that ElevenLabs audio was heard.

API references: [stream speech](https://elevenlabs.io/docs/api-reference/text-to-speech/stream),
[list voices](https://elevenlabs.io/docs/api-reference/voices/search),
[list models](https://elevenlabs.io/docs/api-reference/models/list), and
[model controls](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech).
