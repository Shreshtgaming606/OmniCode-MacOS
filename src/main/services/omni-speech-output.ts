import type { ElevenLabsModel, ElevenLabsVoiceSettings } from '../../shared/elevenlabs-contracts'
import type { OmniVoiceSettings } from '../../shared/omni-contracts'
import type { OmniSettingsManager } from './omni-settings-manager'
import type { OmniVoiceService, TextToSpeechResult } from './omni-voice-service'
import { ElevenLabsTTSProvider, prepareOmniSpeechText } from './elevenlabs-tts-provider'

export interface OmniSpeechResult extends TextToSpeechResult {
  fallbackReason?: string
  startedAt?: number | null
}

/** Main-process output router. Input recognition remains in OmniVoiceService. */
export class OmniSpeechOutput {
  #generation = 0
  #models: { loadedAt: number; values: ElevenLabsModel[] } | null = null

  constructor(
    private readonly system: Pick<OmniVoiceService, 'speak' | 'stop'>,
    private readonly elevenlabs: ElevenLabsTTSProvider,
    private readonly settings: Pick<OmniSettingsManager, 'get' | 'update'>
  ) {}

  connected(): Promise<boolean> { return this.elevenlabs.connected() }
  voices(): ReturnType<ElevenLabsTTSProvider['voices']> { return this.elevenlabs.voices() }

  async models(): Promise<ElevenLabsModel[]> {
    if (this.#models && Date.now() - this.#models.loadedAt < 5 * 60_000) return this.#models.values
    const values = await this.elevenlabs.models()
    this.#models = { loadedAt: Date.now(), values }
    return values
  }

  async connect(key: string): Promise<void> {
    await this.elevenlabs.connect(key)
    this.#models = null
  }

  async disconnect(): Promise<void> {
    await this.stop()
    await this.elevenlabs.disconnect()
    this.#models = null
    await this.settings.update({ voice: { outputProvider: 'system' } })
  }

  async preview(voiceId: string, modelId: string, settings: ElevenLabsVoiceSettings): Promise<OmniSpeechResult> {
    const generation = await this.#begin()
    const model = await this.#model(modelId)
    if (generation !== this.#generation) return { providerId: 'elevenlabs', status: 'interrupted' }
    try {
      const result = await this.elevenlabs.preview(voiceId, model, settings)
      return { providerId: 'elevenlabs', status: 'completed', startedAt: result.startedAt }
    } catch (error) {
      if (generation !== this.#generation) return { providerId: 'elevenlabs', status: 'interrupted' }
      throw error
    }
  }

  async speak(text: string, voice: OmniVoiceSettings): Promise<OmniSpeechResult> {
    const generation = await this.#begin()
    const safeText = prepareOmniSpeechText(text)
    if (!safeText) return { providerId: voice.outputProvider, status: 'completed' }
    if (generation !== this.#generation) return { providerId: voice.outputProvider, status: 'interrupted' }
    if (voice.outputProvider === 'system') return this.system.speak(safeText, {
      rate: voice.speakingRate, ...(voice.voiceId ? { voiceId: voice.voiceId } : {})
    })
    try {
      if (!await this.elevenlabs.connected()) throw new Error('Connect ElevenLabs in Omni voice settings.')
      if (!voice.elevenlabsVoiceId) throw new Error('Choose an ElevenLabs voice.')
      const model = await this.#model(voice.elevenlabsModelId)
      if (generation !== this.#generation) return { providerId: 'elevenlabs', status: 'interrupted' }
      const result = await this.elevenlabs.speak(safeText, voice.elevenlabsVoiceId, model, voice.elevenlabsSettings)
      return { providerId: 'elevenlabs', status: 'completed', startedAt: result.startedAt }
    } catch (error) {
      if (generation !== this.#generation) return { providerId: 'elevenlabs', status: 'interrupted' }
      if (!voice.fallbackToSystem) throw error
      const result = await this.system.speak(safeText, {
        rate: voice.speakingRate, ...(voice.voiceId ? { voiceId: voice.voiceId } : {})
      })
      return { ...result, fallbackReason: error instanceof Error ? error.message : 'ElevenLabs unavailable.' }
    }
  }

  async stop(): Promise<boolean> {
    this.#generation++
    const elevenStopped = this.elevenlabs.stop()
    const systemStopped = await this.system.stop()
    return elevenStopped || systemStopped
  }

  async #begin(): Promise<number> {
    const generation = ++this.#generation
    this.elevenlabs.stop()
    await this.system.stop()
    return generation
  }

  async #model(id: string): Promise<ElevenLabsModel> {
    const models = await this.models()
    const selected = models.find((model) => model.id === id)
      ?? (!id ? models.find((model) => model.id === 'eleven_flash_v2_5') ?? models[0] : undefined)
    if (!selected) throw new Error('The selected ElevenLabs speech model is unavailable.')
    return selected
  }
}
