import { describe, expect, it, vi } from 'vitest'

import type { ElevenLabsModel, ElevenLabsVoiceSettings } from '../../shared/elevenlabs-contracts'
import { ElevenLabsError, ElevenLabsTTSProvider, prepareOmniSpeechText, serializeElevenLabsVoiceSettings, type PCMPlayer } from './elevenlabs-tts-provider'
import { SecureItemNotFoundError } from './secure-keychain-store'

const settings: ElevenLabsVoiceSettings = { stability: 0.6, similarityBoost: 0.8, style: 0.3, speed: 1.1 }
const model: ElevenLabsModel = {
  id: 'eleven_flash_v2_5', name: 'Flash', canUseStyle: true, canUseSpeakerBoost: true,
  canUseSpeed: true, canUseSimilarity: true, maximumTextLength: 40_000
}

function keychain() {
  let value: string | null = null
  return {
    set: vi.fn(async (_account: string, next: string) => { value = next }),
    get: vi.fn(async () => { if (!value) throw new SecureItemNotFoundError('api-key'); return value }),
    has: vi.fn(async () => Boolean(value)),
    delete: vi.fn(async () => { value = null })
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

class FakePCMPlayer implements PCMPlayer {
  readonly writes: Uint8Array[] = []
  startedAt: number | null = null
  finished = false
  stopped = false
  async write(chunk: Uint8Array): Promise<void> {
    this.writes.push(chunk)
    this.startedAt ??= Date.now()
  }
  async finish(): Promise<void> { this.finished = true }
  stop(): void { this.stopped = true }
}

describe('ElevenLabsTTSProvider', () => {
  it('validates without paid generation, stores the key in Keychain, fetches paginated account voices, and deletes only its item', async () => {
    const secure = keychain()
    const secret = 'this-is-a-test-secret-only'
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(init?.headers).toMatchObject({ 'xi-api-key': secret })
      if (/page_size=1(?:&|$)/u.test(url)) return json({ voices: [] })
      if (url.includes('next_page_token')) return json({ voices: [{ voice_id: 'custom_2', name: 'My Voice', category: 'cloned' }], has_more: false })
      return json({ voices: [{ voice_id: 'first_1', name: 'Natural Voice', category: 'premade', labels: { accent: 'American' } }], has_more: true, next_page_token: 'second' })
    }) as typeof fetch
    const provider = new ElevenLabsTTSProvider({ keychain: secure, helperPath: '/unused', fetcher })
    expect(await provider.connected()).toBe(false)
    await provider.connect(secret)
    expect(secure.set).toHaveBeenCalledWith('api-key', secret)
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('/v2/voices?page_size=1')
    expect(await provider.voices()).toMatchObject([
      { id: 'first_1', name: 'Natural Voice', accent: 'American' },
      { id: 'custom_2', name: 'My Voice', category: 'cloned' }
    ])
    await provider.disconnect()
    expect(secure.delete).toHaveBeenCalledWith('api-key')
    expect(await provider.connected()).toBe(false)
  })

  it('rejects invalid credentials without storing or echoing them', async () => {
    const secure = keychain()
    const secret = 'rejected-test-secret-value'
    const provider = new ElevenLabsTTSProvider({
      keychain: secure, helperPath: '/unused', fetcher: vi.fn(async () => json({ detail: 'contains a secret' }, 401)) as typeof fetch
    })
    await expect(provider.connect(secret)).rejects.toThrow('ElevenLabs rejected this API key.')
    expect(secure.set).not.toHaveBeenCalled()
    await expect(provider.speak('Hello', 'voice_1', model, settings)).rejects.toThrow('ElevenLabs rejected this API key.')
  })

  it('streams PCM through the injected player in order and sends sanitized final text only', async () => {
    const secure = keychain()
    await secure.set('api-key', 'mock-key')
    const player = new FakePCMPlayer()
    let requestBody: Record<string, unknown> | null = null
    const provider = new ElevenLabsTTSProvider({
      keychain: secure, helperPath: '/unused', playerFactory: () => player,
      fetcher: vi.fn(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close() } })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/pcm' } })
      }) as typeof fetch
    })
    const result = await provider.speak('Here is [the answer](https://example.com). ```js\nsecret();\n```', 'voice_1', model, settings)
    expect(requestBody).toMatchObject({ model_id: model.id, text: 'Here is the answer. code omitted', voice_settings: {
      stability: 0.6, similarity_boost: 0.8, style: 0.3, speed: 1.1
    } })
    expect(player.writes.map((chunk) => [...chunk])).toEqual([[1, 2], [3, 4]])
    expect(player.finished).toBe(true)
    expect(result.startedAt).toBeTypeOf('number')
  })

  it('stops playback and aborts the request on interruption', async () => {
    const secure = keychain()
    await secure.set('api-key', 'mock-key')
    const player = new FakePCMPlayer()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const provider = new ElevenLabsTTSProvider({
      keychain: secure, helperPath: '/unused', playerFactory: () => player,
      fetcher: vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({ async start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          await gate
          try { controller.enqueue(new Uint8Array([3, 4])); controller.close() } catch { /* aborted */ }
        } })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/pcm' } })
      }) as typeof fetch
    })
    const speech = provider.speak('Hello', 'voice_1', model, settings)
    await vi.waitFor(() => expect(player.writes).toHaveLength(1))
    expect(provider.stop()).toBe(true)
    release()
    await expect(speech).rejects.toMatchObject({ name: 'AbortError' })
    expect(player.stopped).toBe(true)
  })

  it('classifies rate limits and network failures without exposing HTTP response bodies', async () => {
    const secure = keychain()
    await secure.set('api-key', 'mock-key')
    const rateLimited = new ElevenLabsTTSProvider({ keychain: secure, helperPath: '/unused', fetcher: vi.fn(async () => json({ detail: 'private server detail' }, 429)) as typeof fetch })
    await expect(rateLimited.speak('Hello', 'voice_1', model, settings)).rejects.toMatchObject({ code: 'rate-limit' })
    const offline = new ElevenLabsTTSProvider({ keychain: secure, helperPath: '/unused', fetcher: vi.fn(async () => { throw new Error('private network detail') }) as typeof fetch })
    await expect(offline.speak('Hello', 'voice_1', model, settings)).rejects.toMatchObject({ code: 'network' })
  })

  it('filters model controls according to the API catalog and documented model limits', async () => {
    const secure = keychain()
    await secure.set('api-key', 'mock-key')
    const provider = new ElevenLabsTTSProvider({ keychain: secure, helperPath: '/unused', fetcher: vi.fn(async () => json([
      { model_id: 'eleven_flash_v2_5', name: 'Flash', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true },
      { model_id: 'eleven_v4_turbo', name: 'V4 Turbo', can_do_text_to_speech: true, can_use_style: false },
      { model_id: 'not_tts', can_do_text_to_speech: false }
    ])) as typeof fetch })
    const models = await provider.models()
    expect(models.map((item) => item.id)).toEqual(['eleven_flash_v2_5', 'eleven_v4_turbo'])
    expect(serializeElevenLabsVoiceSettings(settings, models[0])).toMatchObject({ speed: 1.1, style: 0.3, similarity_boost: 0.8 })
    expect(serializeElevenLabsVoiceSettings(settings, models[1])).toEqual({ stability: 0.6, similarity_boost: 0.8 })
  })

  it('removes code blocks, markdown links, URLs, and obvious credentials from spoken text', () => {
    const value = prepareOmniSpeechText('Result [here](https://example.com). Visit https://example.com. ```json\n{"token":"abc"}\n``` API key: sk-123456789abcdef')
    expect(value).toContain('Result here')
    expect(value).toContain('a link')
    expect(value).not.toContain('example.com')
    expect(value).not.toContain('"token"')
    expect(value).not.toContain('sk-123456789abcdef')
  })

  it('never speaks private reasoning or an unfinished code fence', () => {
    const value = prepareOmniSpeechText('Public answer. <think>private reasoning</think> More public. <|analysis|>hidden text<|final|> Final. ```json\n{"private":true}')
    expect(value).toContain('Public answer')
    expect(value).toContain('Final')
    expect(value).not.toContain('private reasoning')
    expect(value).not.toContain('hidden text')
    expect(value).not.toContain('"private"')
    expect(prepareOmniSpeechText('Hello sk_test_only_secret_1234567890123456')).not.toContain('sk_test_only_secret_1234567890123456')
  })
})
