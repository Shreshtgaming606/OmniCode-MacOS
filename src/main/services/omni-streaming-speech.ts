import type { OmniVoiceSettings } from '../../shared/omni-contracts'
import { prepareOmniSpeechText } from './elevenlabs-tts-provider'
import type { OmniSpeechOutput, OmniSpeechResult } from './omni-speech-output'

/**
 * Used only for chat-only final-answer deltas. Tool-planning turns are never
 * sent here because their text may be operational rather than user-facing.
 */
export class OmniStreamingSpeech {
  #pending = ''
  #received = ''
  #queue: Promise<void> = Promise.resolve()
  #voice: OmniVoiceSettings
  #cancelled = false
  #started = false

  constructor(
    private readonly output: Pick<OmniSpeechOutput, 'speak'>,
    voice: OmniVoiceSettings,
    private readonly events: {
      start(text: string): void
      fallback(reason: string): void
      finish(interrupted: boolean): void
      error(): void
    }
  ) { this.#voice = { ...voice } }

  push(delta: string): void {
    if (this.#cancelled || typeof delta !== 'string' || !delta) return
    this.#received += delta
    this.#pending += delta
    this.#drain(false)
  }

  async finish(finalText: string): Promise<void> {
    if (this.#cancelled) return
    // If a provider did not deliver deltas, the completed answer is still read.
    if (finalText.startsWith(this.#received)) this.#pending += finalText.slice(this.#received.length)
    else if (!this.#started && finalText) this.#pending = finalText
    this.#drain(true)
    try {
      await this.#queue
      this.events.finish(this.#cancelled)
    } catch {
      if (!this.#cancelled) this.events.error()
    }
  }

  cancel(): void { this.#cancelled = true; this.#pending = '' }

  #drain(final: boolean): void {
    while (this.#pending) {
      const hidden = /^<(think|analysis|reasoning)\b[^>]*>/iu.exec(this.#pending)
      if (hidden) {
        const closing = new RegExp(`</${hidden[1]}\\s*>`, 'iu').exec(this.#pending.slice(hidden[0].length))
        if (!closing) { if (final) this.#pending = ''; return }
        this.#pending = this.#pending.slice(hidden[0].length + closing.index + closing[0].length)
        continue
      }
      if (/^<\|(?:analysis|reasoning)\|>/iu.test(this.#pending)) {
        const finalMarker = /<\|final\|>/iu.exec(this.#pending)
        if (!finalMarker) { if (final) this.#pending = ''; return }
        this.#pending = this.#pending.slice(finalMarker.index + finalMarker[0].length)
        continue
      }
      const fence = this.#pending.indexOf('```')
      const markup = this.#pending.search(/<(?=[A-Za-z/|])/u)
      const sentence = /[.!?](?=\s|$)/u.exec(this.#pending)
      let end = sentence ? sentence.index + 1 : -1
      if (end < 0 && this.#pending.length > 320) {
        end = this.#pending.lastIndexOf(' ', 280)
      }
      if (fence >= 0 && (end < 0 || fence < end) && (markup < 0 || fence < markup)) {
        const close = this.#pending.indexOf('```', fence + 3)
        if (close < 0) { if (final) this.#pending = this.#pending.slice(0, fence); else return }
        else {
          this.#pending = `${this.#pending.slice(0, fence)} code omitted ${this.#pending.slice(close + 3)}`
        }
        continue
      }
      if (markup >= 0 && (end < 0 || markup < end)) {
        if (markup > 0) {
          const prefix = this.#pending.slice(0, markup)
          this.#pending = this.#pending.slice(markup)
          this.#enqueue(prefix)
          continue
        }
        // A tag may be split across provider deltas. Wait for its closing `>`
        // before deciding whether it starts a private section.
        const tagEnd = this.#pending.indexOf('>')
        if (tagEnd < 0) { if (final) this.#pending = ''; return }
        this.#pending = this.#pending.slice(tagEnd + 1)
        continue
      }
      if (end < 0) {
        if (final) { const tail = this.#pending; this.#pending = ''; this.#enqueue(tail) }
        return
      }
      const chunk = this.#pending.slice(0, end)
      this.#pending = this.#pending.slice(end).trimStart()
      this.#enqueue(chunk)
    }
  }

  #enqueue(raw: string): void {
    const text = prepareOmniSpeechText(raw)
    if (!text) return
    this.#queue = this.#queue.then(async () => {
      if (this.#cancelled) return
      if (!this.#started) { this.#started = true; this.events.start(text) }
      const result: OmniSpeechResult = await this.output.speak(text, this.#voice)
      if (result.fallbackReason) {
        this.events.fallback(result.fallbackReason)
        this.#voice = { ...this.#voice, outputProvider: 'system' }
      }
    })
  }
}
