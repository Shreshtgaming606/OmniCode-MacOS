import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type { ElevenLabsModel, ElevenLabsVoice, ElevenLabsVoiceSettings } from '../../shared/elevenlabs-contracts'
import { redactOmniActivityText } from './omni-task-store'
import { SecureItemNotFoundError, SecureKeychainStore } from './secure-keychain-store'

const API_ORIGIN = 'https://api.elevenlabs.io'
const KEY_ACCOUNT = 'api-key'
const MAX_CATALOG_BYTES = 4 * 1_024 * 1_024
const MAX_PCM_BYTES = 24 * 1_024 * 1_024
const PREVIEW_TEXT = "Hello! I'm Omni. How can I help you today?"
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/u

export interface PCMPlayer {
  write(chunk: Uint8Array): Promise<void>
  finish(): Promise<void>
  stop(): void
  readonly startedAt: number | null
}

export class NativePCMPlayer implements PCMPlayer {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #completion: Promise<number | null>
  #startedAt: number | null = null
  #stopped = false

  constructor(helperPath: string) {
    this.#child = spawn(helperPath, ['--play-pcm-24000'], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    })
    this.#child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.includes(Buffer.from('STARTED'))) this.#startedAt ??= Date.now()
    })
    // The native helper never includes user text, HTTP details, or credentials
    // in stderr. Discard it instead of routing it into diagnostics.
    this.#child.stderr.resume()
    this.#child.stdin.on('error', () => undefined)
    this.#completion = new Promise((resolve, reject) => {
      this.#child.once('error', reject)
      this.#child.once('close', resolve)
    })
    void this.#completion.catch(() => undefined)
  }

  get startedAt(): number | null { return this.#startedAt }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#stopped) throw new DOMException('Voice playback stopped.', 'AbortError')
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve())
    })
  }

  async finish(): Promise<void> {
    if (this.#stopped) throw new DOMException('Voice playback stopped.', 'AbortError')
    this.#child.stdin.end()
    const code = await this.#completion
    if (code !== 0) throw new Error('Omni could not play ElevenLabs audio.')
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#child.stdin.destroy()
    this.#child.kill('SIGTERM')
    void this.#completion.catch(() => undefined)
  }
}

export class ElevenLabsError extends Error {
  constructor(readonly code: 'invalid-key' | 'rate-limit' | 'unavailable' | 'invalid-voice' | 'network' | 'timeout' | 'invalid-response') {
    super({
      'invalid-key': 'ElevenLabs rejected this API key.',
      'rate-limit': 'ElevenLabs rate limit or quota reached.',
      unavailable: 'ElevenLabs is unavailable.',
      'invalid-voice': 'The selected ElevenLabs voice is unavailable.',
      network: 'ElevenLabs could not be reached.',
      timeout: 'ElevenLabs did not respond in time.',
      'invalid-response': 'ElevenLabs returned an invalid response.'
    }[code])
    this.name = 'ElevenLabsError'
  }
}

function responseError(status: number): ElevenLabsError {
  if (status === 401 || status === 403) return new ElevenLabsError('invalid-key')
  if (status === 404 || status === 422) return new ElevenLabsError('invalid-voice')
  if (status === 429) return new ElevenLabsError('rate-limit')
  return new ElevenLabsError('unavailable')
}

function safeResourceId(value: string): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) throw new ElevenLabsError('invalid-response')
  return value
}

function shortText(value: unknown, maximum = 200): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum) : ''
}

/** Only the user-facing spoken answer is sent to a TTS provider. */
export function prepareOmniSpeechText(value: string): string {
  if (typeof value !== 'string') return ''
  const readable = value.slice(0, 4_000)
    // A model may emit private reasoning markers even on a user-facing stream.
    // Never send those sections to either the cloud or system speech provider.
    .replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(?:think|analysis|reasoning)\b[^>]*>[\s\S]*$/giu, ' ')
    .replace(/<\|(?:analysis|reasoning)\|>[\s\S]*?<\|final\|>/giu, ' ')
    .replace(/<\|(?:analysis|reasoning)\|>[\s\S]*$/giu, ' ')
    .replace(/```[\s\S]*?(?:```|$)/gu, ' code omitted ')
    .replace(/`([^`\n]{1,120})`/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, 'a link')
    .replace(/^\s*\|.*\|\s*$/gmu, ' ')
    .replace(/^[\s>*#_-]+/gmu, ' ')
    .replace(/\bsk_[A-Za-z0-9_-]{16,}\b/gu, '••••')
  return redactOmniActivityText(readable, 4_000)
    .replace(/\[REDACTED_URL\]/gu, 'a link')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 2_000)
}

function modelCapabilities(value: Record<string, unknown>): ElevenLabsModel | null {
  const id = shortText(value.model_id, 128)
  if (!RESOURCE_ID.test(id) || value.can_do_text_to_speech !== true || value.requires_alpha_access === true) return null
  const v3 = /^eleven_v3(?:_|$)/u.test(id)
  const v4 = /^eleven_v4(?:_|$)/u.test(id)
  const v2 = /^eleven_(?:flash|turbo|multilingual|english)_v2/u.test(id)
  return {
    id, name: shortText(value.name, 120) || id,
    canUseStyle: value.can_use_style === true && !v3 && !v4,
    canUseSpeakerBoost: value.can_use_speaker_boost === true && !v3 && !v4,
    canUseSpeed: v2,
    canUseSimilarity: !v3,
    maximumTextLength: typeof value.maximum_text_length_per_request === 'number' && Number.isFinite(value.maximum_text_length_per_request)
      ? Math.max(1, Math.min(40_000, Math.floor(value.maximum_text_length_per_request))) : 2_000
  }
}

export function serializeElevenLabsVoiceSettings(settings: ElevenLabsVoiceSettings, model: ElevenLabsModel): Record<string, number | boolean> {
  const bounded = (value: number, min: number, max: number): number => {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error('Choose valid ElevenLabs voice settings.')
    return value
  }
  return {
    stability: bounded(settings.stability, 0, 1),
    ...(model.canUseSimilarity ? { similarity_boost: bounded(settings.similarityBoost, 0, 1) } : {}),
    ...(model.canUseStyle ? { style: bounded(settings.style, 0, 1) } : {}),
    ...(model.canUseSpeed ? { speed: bounded(settings.speed, 0.7, 1.2) } : {}),
    ...(model.canUseSpeakerBoost ? { use_speaker_boost: true } : {})
  }
}

export interface ElevenLabsTTSOptions {
  keychain: Pick<SecureKeychainStore, 'get' | 'set' | 'has' | 'delete'>
  helperPath: string
  fetcher?: typeof fetch
  playerFactory?: () => PCMPlayer
}

export class ElevenLabsTTSProvider {
  readonly id = 'elevenlabs'
  readonly #keychain: ElevenLabsTTSOptions['keychain']
  readonly #fetcher: typeof fetch
  readonly #playerFactory: () => PCMPlayer
  #active: { controller: AbortController; player: PCMPlayer | null } | null = null

  constructor(options: ElevenLabsTTSOptions) {
    this.#keychain = options.keychain
    this.#fetcher = options.fetcher ?? fetch
    this.#playerFactory = options.playerFactory ?? (() => new NativePCMPlayer(options.helperPath))
  }

  async connected(): Promise<boolean> { return this.#keychain.has(KEY_ACCOUNT) }

  async connect(key: string): Promise<void> {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{16,256}$/u.test(key.trim())) throw new ElevenLabsError('invalid-key')
    const normalized = key.trim()
    const result = await this.#requestJson('/v2/voices?page_size=1', normalized)
    if (!result || typeof result !== 'object' || !Array.isArray((result as Record<string, unknown>).voices)) {
      throw new ElevenLabsError('invalid-response')
    }
    try { await this.#keychain.set(KEY_ACCOUNT, normalized) }
    catch { throw new Error('Could not save ElevenLabs in macOS Keychain.') }
  }

  async disconnect(): Promise<void> {
    this.stop()
    await this.#keychain.delete(KEY_ACCOUNT)
  }

  async voices(): Promise<ElevenLabsVoice[]> {
    const key = await this.#key()
    const voices: ElevenLabsVoice[] = []
    let nextPage: string | null = null
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ page_size: '100' })
      if (nextPage) query.set('next_page_token', nextPage)
      const result = await this.#requestJson(`/v2/voices?${query.toString()}`, key)
      if (!result || typeof result !== 'object' || !Array.isArray((result as Record<string, unknown>).voices)) throw new ElevenLabsError('invalid-response')
      const body = result as { voices: unknown[]; has_more?: boolean; next_page_token?: unknown }
      for (const value of body.voices) {
        if (!value || typeof value !== 'object') continue
        const voice = value as Record<string, unknown>
        const id = shortText(voice.voice_id, 128)
        const name = shortText(voice.name, 120)
        if (!RESOURCE_ID.test(id) || !name) continue
        const labels = voice.labels && typeof voice.labels === 'object' ? voice.labels as Record<string, unknown> : {}
        voices.push({
          id, name, category: shortText(voice.category, 80), description: shortText(voice.description, 240),
          accent: shortText(labels.accent, 80), language: shortText(labels.language ?? voice.language, 80)
        })
      }
      nextPage = body.has_more === true && typeof body.next_page_token === 'string' ? body.next_page_token : null
      if (!nextPage) break
    }
    return voices
  }

  async models(): Promise<ElevenLabsModel[]> {
    const result = await this.#requestJson('/v1/models', await this.#key())
    if (!Array.isArray(result)) throw new ElevenLabsError('invalid-response')
    return result.flatMap((value) => value && typeof value === 'object' ? modelCapabilities(value as Record<string, unknown>) ?? [] : [])
  }

  async preview(voiceId: string, model: ElevenLabsModel, settings: ElevenLabsVoiceSettings): Promise<{ startedAt: number | null }> {
    return this.speak(PREVIEW_TEXT, voiceId, model, settings)
  }

  async speak(text: string, voiceId: string, model: ElevenLabsModel, settings: ElevenLabsVoiceSettings, signal?: AbortSignal): Promise<{ startedAt: number | null }> {
    this.stop()
    const safeText = prepareOmniSpeechText(text)
    if (!safeText) throw new Error('There is no spoken text to generate.')
    if (safeText.length > model.maximumTextLength) throw new Error('The spoken response exceeds the selected ElevenLabs model limit.')
    const controller = new AbortController()
    const active = { controller, player: null as PCMPlayer | null }
    this.#active = active
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort()
    const timeout = setTimeout(() => controller.abort(), 90_000)
    try {
      const key = await this.#key()
      if (controller.signal.aborted) throw new DOMException('Voice playback stopped.', 'AbortError')
      let response: Response
      try {
        response = await this.#fetcher(`${API_ORIGIN}/v1/text-to-speech/${safeResourceId(voiceId)}/stream?output_format=pcm_24000`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
          body: JSON.stringify({ text: safeText, model_id: safeResourceId(model.id), voice_settings: serializeElevenLabsVoiceSettings(settings, model) })
        })
      } catch (error) {
        if (controller.signal.aborted) throw new DOMException('Voice playback stopped.', 'AbortError')
        throw new ElevenLabsError('network')
      }
      if (!response.ok) throw responseError(response.status)
      const mediaType = response.headers.get('content-type') ?? ''
      if (!response.body || !/^(?:audio\/|application\/octet-stream)/iu.test(mediaType)) throw new ElevenLabsError('invalid-response')
      const player = this.#playerFactory()
      active.player = player
      let bytes = 0
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value: chunk } = await reader.read()
          if (done) break
          if (controller.signal.aborted) throw new DOMException('Voice playback stopped.', 'AbortError')
          bytes += chunk.byteLength
          if (bytes > MAX_PCM_BYTES) throw new ElevenLabsError('invalid-response')
          await player.write(chunk)
        }
      } finally { reader.releaseLock() }
      if (!bytes) throw new ElevenLabsError('invalid-response')
      await player.finish()
      return { startedAt: player.startedAt }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (this.#active === active) this.#active = null
      if (controller.signal.aborted || active.player) active.player?.stop()
    }
  }

  stop(): boolean {
    const active = this.#active
    if (!active) return false
    this.#active = null
    active.controller.abort()
    active.player?.stop()
    return true
  }

  async #key(): Promise<string> {
    try { return await this.#keychain.get(KEY_ACCOUNT) }
    catch (error) {
      if (error instanceof SecureItemNotFoundError) throw new ElevenLabsError('invalid-key')
      throw new ElevenLabsError('unavailable')
    }
  }

  async #requestJson(relativePath: string, key: string): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    try {
      let response: Response
      try {
        response = await this.#fetcher(`${API_ORIGIN}${relativePath}`, {
          headers: { 'xi-api-key': key, Accept: 'application/json' }, signal: controller.signal, redirect: 'error'
        })
      } catch {
        throw new ElevenLabsError(controller.signal.aborted ? 'timeout' : 'network')
      }
      if (!response.ok) throw responseError(response.status)
      if (!response.body) throw new ElevenLabsError('invalid-response')
      let size = 0
      const chunks: Uint8Array[] = []
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value: chunk } = await reader.read()
          if (done) break
          size += chunk.byteLength
          if (size > MAX_CATALOG_BYTES) throw new ElevenLabsError('invalid-response')
          chunks.push(chunk)
        }
      } finally { reader.releaseLock() }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
      catch { throw new ElevenLabsError('invalid-response') }
    } finally { clearTimeout(timeout) }
  }
}
