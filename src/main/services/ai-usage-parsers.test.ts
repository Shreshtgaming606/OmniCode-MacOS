import { describe, expect, it } from 'vitest'

import {
  parseAnthropicUsage,
  parseGeminiUsage,
  parseOllamaUsage,
  parseOpenAIUsage,
  parseRateLimitHeaders
} from './ai-usage-parsers'

describe('AI provider usage parsers', () => {
  it('normalizes OpenAI cached and reasoning tokens', () => {
    expect(parseOpenAIUsage({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 12 }
    })).toEqual({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 80, reasoningTokens: 12, totalTokens: 150 })
  })

  it('includes Anthropic cache reads and writes in total input', () => {
    expect(parseAnthropicUsage({
      input_tokens: 40,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 20,
      output_tokens: 10
    })).toEqual({ inputTokens: 120, outputTokens: 10, cachedInputTokens: 60, cacheWriteInputTokens: 20, totalTokens: 130 })
  })

  it('normalizes Gemini and Ollama metadata without estimating tokens', () => {
    expect(parseGeminiUsage({ promptTokenCount: 20, candidatesTokenCount: 5, cachedContentTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 28 }))
      .toEqual({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 4, reasoningTokens: 3, totalTokens: 28 })
    expect(parseOllamaUsage({ prompt_eval_count: 8, eval_count: 2 })).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10 })
    expect(parseOllamaUsage({ response: 'no usage counters' })).toBeUndefined()
  })

  it('captures useful rate-limit response metadata', () => {
    expect(parseRateLimitHeaders(new Headers({
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-remaining-tokens': '42',
      'retry-after': '7'
    }), 429)).toEqual({ status: 'limited', requestsRemaining: 0, tokensRemaining: 42, retryAfterSeconds: 7, resetAt: undefined })
  })
})
