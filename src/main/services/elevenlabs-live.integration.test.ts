import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ElevenLabsTTSProvider } from './elevenlabs-tts-provider'
import { SecureKeychainStore } from './secure-keychain-store'

/**
 * Explicit opt-in only: this generates a short paid/freemium voice preview.
 * The test reads the app's existing Keychain item and never prints its value.
 * Run after building the native helper with OMNICODE_TEST_ELEVENLABS=1.
 */
describe.skipIf(process.env.OMNICODE_TEST_ELEVENLABS !== '1')('ElevenLabs live integration', () => {
  it('loads the account catalog and streams a short preview into the native player', async () => {
    const provider = new ElevenLabsTTSProvider({
      keychain: new SecureKeychainStore('com.omnicode.editor.elevenlabs'),
      helperPath: path.join(process.cwd(), 'out/native/omnicode-speech-helper.app/Contents/MacOS/omnicode-speech-helper')
    })
    expect(await provider.connected(), 'Connect a valid key in Omni settings before opting in.').toBe(true)
    const [voices, models] = await Promise.all([provider.voices(), provider.models()])
    expect(voices.length).toBeGreaterThan(0)
    expect(models.length).toBeGreaterThan(0)
    const model = models.find((item) => item.id === 'eleven_flash_v2_5') ?? models[0]
    const result = await provider.preview(voices[0].id, model, {
      stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1
    })
    expect(result.startedAt).not.toBeNull()
  }, 120_000)
})
