import { describe, expect, it, vi } from 'vitest'

import { createDefaultOmniSettings } from '../../shared/omni-contracts'
import type { ElevenLabsTTSProvider } from './elevenlabs-tts-provider'
import type { OmniSettingsManager } from './omni-settings-manager'
import type { OmniVoiceService } from './omni-voice-service'
import { OmniSpeechOutput } from './omni-speech-output'

function setup() {
  const system = {
    speak: vi.fn(async () => ({ providerId: 'macos-say', status: 'completed' as const })),
    stop: vi.fn(async () => false)
  }
  const eleven = {
    connected: vi.fn(async () => true),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    voices: vi.fn(async () => []),
    models: vi.fn(async () => [{
      id: 'eleven_flash_v2_5', name: 'Flash', canUseStyle: true, canUseSpeakerBoost: true,
      canUseSpeed: true, canUseSimilarity: true, maximumTextLength: 40_000
    }]),
    preview: vi.fn(async () => ({ startedAt: 123 })),
    speak: vi.fn(async () => ({ startedAt: 123 })),
    stop: vi.fn(() => false)
  }
  const settings = {
    get: vi.fn(async () => createDefaultOmniSettings()),
    update: vi.fn(async () => createDefaultOmniSettings())
  }
  const output = new OmniSpeechOutput(
    system as unknown as OmniVoiceService,
    eleven as unknown as ElevenLabsTTSProvider,
    settings as unknown as OmniSettingsManager
  )
  const voice = { ...createDefaultOmniSettings().voice, outputProvider: 'elevenlabs' as const, elevenlabsVoiceId: 'voice_1' }
  return { output, voice, eleven, system, settings }
}

describe('OmniSpeechOutput', () => {
  it('routes speech and previews through the selected ElevenLabs model and voice', async () => {
    const { output, voice, eleven, system } = setup()
    await expect(output.speak('Hello, Omni.', voice)).resolves.toMatchObject({ providerId: 'elevenlabs', status: 'completed' })
    expect(eleven.speak).toHaveBeenCalledWith('Hello, Omni.', 'voice_1', expect.objectContaining({ id: 'eleven_flash_v2_5' }), voice.elevenlabsSettings)
    await expect(output.preview('voice_1', 'eleven_flash_v2_5', voice.elevenlabsSettings)).resolves.toMatchObject({ status: 'completed', startedAt: 123 })
    expect(system.speak).not.toHaveBeenCalled()
  })

  it('falls back to macOS speech after ElevenLabs failure and respects fallback off', async () => {
    const { output, voice, eleven, system } = setup()
    eleven.speak.mockRejectedValueOnce(new Error('ElevenLabs rate limit reached.'))
    await expect(output.speak('Keep the answer visible.', voice)).resolves.toMatchObject({
      providerId: 'macos-say', status: 'completed', fallbackReason: 'ElevenLabs rate limit reached.'
    })
    expect(system.speak).toHaveBeenCalledOnce()
    eleven.speak.mockRejectedValueOnce(new Error('ElevenLabs offline.'))
    await expect(output.speak('Keep the answer visible.', { ...voice, fallbackToSystem: false })).rejects.toThrow('ElevenLabs offline.')
    expect(system.speak).toHaveBeenCalledOnce()
  })

  it('defaults to System Voice and removes only ElevenLabs credentials on disconnect', async () => {
    const { output, voice, eleven, system, settings } = setup()
    await output.speak('Hello.', { ...voice, outputProvider: 'system' })
    expect(system.speak).toHaveBeenCalledOnce()
    expect(eleven.speak).not.toHaveBeenCalled()
    await output.disconnect()
    expect(eleven.disconnect).toHaveBeenCalledOnce()
    expect(settings.update).toHaveBeenCalledWith({ voice: { outputProvider: 'system' } })
  })
})
