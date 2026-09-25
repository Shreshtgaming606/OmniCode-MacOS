import type { AIProviderUsageMetadata, AIRateLimitSnapshot } from '../../shared/ai-usage-contracts'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  return values.some((value) => value !== undefined)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined
}

export function parseOpenAIUsage(value: unknown): AIProviderUsageMetadata | undefined {
  const usage = object(value)
  if (!usage) return undefined
  const prompt = count(usage.prompt_tokens ?? usage.input_tokens)
  const output = count(usage.completion_tokens ?? usage.output_tokens)
  const promptDetails = object(usage.prompt_tokens_details ?? usage.input_tokens_details)
  const outputDetails = object(usage.completion_tokens_details ?? usage.output_tokens_details)
  const result: AIProviderUsageMetadata = {
    inputTokens: prompt,
    outputTokens: output,
    cachedInputTokens: count(promptDetails?.cached_tokens),
    reasoningTokens: count(outputDetails?.reasoning_tokens),
    totalTokens: count(usage.total_tokens) ?? sumDefined(prompt, output)
  }
  return Object.values(result).some((item) => item !== undefined) ? result : undefined
}

export function parseAnthropicUsage(value: unknown): AIProviderUsageMetadata | undefined {
  const usage = object(value)
  if (!usage) return undefined
  const baseInput = count(usage.input_tokens)
  const cached = count(usage.cache_read_input_tokens)
  const cacheWrite = count(usage.cache_creation_input_tokens)
  const output = count(usage.output_tokens)
  const totalInput = sumDefined(baseInput, cached, cacheWrite)
  const result: AIProviderUsageMetadata = {
    inputTokens: totalInput,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    totalTokens: sumDefined(totalInput, output)
  }
  return Object.values(result).some((item) => item !== undefined) ? result : undefined
}

export function parseGeminiUsage(value: unknown): AIProviderUsageMetadata | undefined {
  const usage = object(value)
  if (!usage) return undefined
  const input = count(usage.promptTokenCount)
  const output = count(usage.candidatesTokenCount)
  const result: AIProviderUsageMetadata = {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: count(usage.cachedContentTokenCount),
    reasoningTokens: count(usage.thoughtsTokenCount),
    totalTokens: count(usage.totalTokenCount) ?? sumDefined(input, output)
  }
  return Object.values(result).some((item) => item !== undefined) ? result : undefined
}

export function parseOllamaUsage(value: unknown): AIProviderUsageMetadata | undefined {
  const usage = object(value)
  if (!usage) return undefined
  const input = count(usage.prompt_eval_count)
  const output = count(usage.eval_count)
  const result: AIProviderUsageMetadata = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: sumDefined(input, output)
  }
  return Object.values(result).some((item) => item !== undefined) ? result : undefined
}

function headerCount(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

export function parseRateLimitHeaders(headers: Headers, status?: number): AIRateLimitSnapshot | undefined {
  const requestsRemaining = headerCount(headers, 'x-ratelimit-remaining-requests')
  const tokensRemaining = headerCount(headers, 'x-ratelimit-remaining-tokens')
  const retryAfterSeconds = headerCount(headers, 'retry-after')
  const resetRaw = headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset')
  let resetAt: string | undefined
  if (resetRaw) {
    const timestamp = Number(resetRaw)
    if (Number.isFinite(timestamp) && timestamp > 0) {
      const millis = timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000
      try { resetAt = new Date(millis).toISOString() } catch { resetAt = undefined }
    }
  }
  if (requestsRemaining === undefined && tokensRemaining === undefined && retryAfterSeconds === undefined && !resetAt && status !== 429) return undefined
  return {
    status: status === 429 || retryAfterSeconds !== undefined || requestsRemaining === 0 || tokensRemaining === 0 ? 'limited' : 'healthy',
    requestsRemaining,
    tokensRemaining,
    retryAfterSeconds,
    resetAt
  }
}
