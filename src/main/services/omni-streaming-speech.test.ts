import { describe, expect, it, vi } from 'vitest'

import { createDefaultOmniSettings } from '../../shared/omni-contracts'
import { OmniStreamingSpeech } from './omni-streaming-speech'

const voice = { ...createDefaultOmniSettings().voice, outputProvider: 'elevenlabs' as const, elevenlabsVoiceId: 'voice_1' }

describe('OmniStreamingSpeech', () => {
  it('speaks complete user-facing sentences in order, then flushes the final tail', async () => {
    const played: string[] = []
    const output = { speak: vi.fn(async (text: string) => {
      played.push(text)
      return { providerId: 'elevenlabs', status: 'completed' as const }
    }) }
    const events = { start: vi.fn(), fallback: vi.fn(), finish: vi.fn(), error: vi.fn() }
    const session = new OmniStreamingSpeech(output, voice, events)
    session.push('Hello there. I found')
    session.push(' three results. Here is the')
    await session.finish('Hello there. I found three results. Here is the summary')
    expect(played).toEqual(['Hello there.', 'I found three results.', 'Here is the summary'])
    expect(events.start).toHaveBeenCalledOnce()
    expect(events.finish).toHaveBeenCalledWith(false)
    expect(events.error).not.toHaveBeenCalled()
  })

  it('never sends a reasoning tag or fenced code to the speech provider', async () => {
    const output = { speak: vi.fn(async (_text: string) => ({ providerId: 'elevenlabs', status: 'completed' as const })) }
    const session = new OmniStreamingSpeech(output, voice, { start: vi.fn(), fallback: vi.fn(), finish: vi.fn(), error: vi.fn() })
    session.push('<think>I should reveal a')
    session.push(' secret.</think>Here is the answer. ```js\nsecret();\n```')
    await session.finish('Here is the answer.')
    const spoken = output.speak.mock.calls.map((call) => call[0]).join(' ')
    expect(spoken).toContain('Here is the answer')
    expect(spoken).not.toContain('secret')
    expect(spoken).not.toContain('<think>')
  })

  it('holds split reasoning markers and never sends their contents to TTS', async () => {
    const output = { speak: vi.fn(async (_text: string) => ({ providerId: 'elevenlabs', status: 'completed' as const })) }
    const session = new OmniStreamingSpeech(output, voice, { start: vi.fn(), fallback: vi.fn(), finish: vi.fn(), error: vi.fn() })
    session.push('Here is the answer. <thi')
    session.push('nk>Do not speak this. </think> Public follow-up.')
    session.push('<|anal')
    session.push('ysis|>Or this. <|final|> Final answer.')
    await session.finish('Here is the answer. <think>Do not speak this. </think> Public follow-up.<|analysis|>Or this. <|final|> Final answer.')
    const spoken = output.speak.mock.calls.map((call) => call[0]).join(' ')
    expect(spoken).toContain('Here is the answer')
    expect(spoken).toContain('Final answer')
    expect(spoken).not.toContain('Do not speak this')
    expect(spoken).not.toContain('Or this')
  })

  it('switches remaining chunks to System Voice after one fallback and cancels queued chunks', async () => {
    const voices: string[] = []
    const output = { speak: vi.fn(async (_text: string, options: typeof voice) => {
      voices.push(options.outputProvider)
      return voices.length === 1
        ? { providerId: 'macos-say', status: 'completed' as const, fallbackReason: 'ElevenLabs rate limit reached.' }
        : { providerId: 'macos-say', status: 'completed' as const }
    }) }
    const events = { start: vi.fn(), fallback: vi.fn(), finish: vi.fn(), error: vi.fn() }
    const session = new OmniStreamingSpeech(output, voice, events)
    session.push('First sentence. Second sentence.')
    await session.finish('First sentence. Second sentence.')
    expect(voices).toEqual(['elevenlabs', 'system'])
    expect(events.fallback).toHaveBeenCalledOnce()

    const never = { speak: vi.fn(async () => ({ providerId: 'elevenlabs', status: 'completed' as const })) }
    const cancelled = new OmniStreamingSpeech(never, voice, events)
    cancelled.push('No speech should play.')
    cancelled.cancel()
    await cancelled.finish('No speech should play.')
    expect(never.speak).not.toHaveBeenCalled()
  })
})
