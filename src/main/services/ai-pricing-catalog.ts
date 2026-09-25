import type {
  AICostEstimate,
  AIProviderUsageMetadata,
  AIUsageProvider,
  ModelPricing
} from '../../shared/ai-usage-contracts'

export const AI_PRICING_CATALOG_VERSION = '2026-09-24.1'
export const AI_PRICING_LAST_UPDATED = '2026-09-24'

const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing'
const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/models/overview'
const GEMINI_PRICING = 'https://ai.google.dev/gemini-api/docs/pricing'

function cloud(
  provider: Exclude<AIUsageProvider, 'ollama'>,
  model: string,
  displayName: string,
  input: number,
  output: number,
  options: Partial<ModelPricing> = {}
): ModelPricing {
  return {
    provider,
    model,
    displayName,
    inputPricePerMillionTokens: input,
    outputPricePerMillionTokens: output,
    effectiveDate: '2026-09-24',
    lastUpdated: AI_PRICING_LAST_UPDATED,
    sourceUrl: provider === 'openai' ? OPENAI_PRICING : provider === 'anthropic' ? ANTHROPIC_PRICING : GEMINI_PRICING,
    status: 'CURRENT',
    ...options
  }
}

/**
 * Bundled standard, synchronous text-API prices in USD per million tokens.
 * Entries are deliberately narrow. Unknown model IDs stay unpriced instead of
 * inheriting a family price that may not apply to their tier or modality.
 */
export const BUNDLED_MODEL_PRICING: readonly ModelPricing[] = [
  cloud('openai', 'gpt-5-mini', 'GPT-5 mini', 0.25, 2),
  cloud('openai', 'gpt-5-nano', 'GPT-5 nano', 0.05, 0.4),
  cloud('openai', 'gpt-5', 'GPT-5', 1.25, 10),
  cloud('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', 0.4, 1.6, {
    cachedInputPricePerMillionTokens: 0.1
  }),
  cloud('openai', 'gpt-4.1-nano', 'GPT-4.1 nano', 0.1, 0.4, {
    cachedInputPricePerMillionTokens: 0.025
  }),
  cloud('openai', 'gpt-4.1', 'GPT-4.1', 2, 8, {
    cachedInputPricePerMillionTokens: 0.5
  }),
  cloud('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', 2, 10, {
    cachedInputPricePerMillionTokens: 0.2,
    cacheWriteInputPricePerMillionTokens: 2.5,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000
  }),
  cloud('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 1, 5, {
    cachedInputPricePerMillionTokens: 0.1,
    cacheWriteInputPricePerMillionTokens: 1.25,
    contextWindow: 200_000,
    maxOutputTokens: 64_000
  }),
  cloud('google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 0.75, 3.75, {
    cachedInputPricePerMillionTokens: 0.075,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000
  }),
  cloud('google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', 0.75, 3.75, {
    cachedInputPricePerMillionTokens: 0.075,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000
  }),
  cloud('google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', 0.75, 3.75, {
    cachedInputPricePerMillionTokens: 0.075,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000
  }),
  {
    provider: 'ollama',
    model: '*',
    displayName: 'Local Ollama model',
    inputPricePerMillionTokens: 0,
    outputPricePerMillionTokens: 0,
    cachedInputPricePerMillionTokens: 0,
    cacheWriteInputPricePerMillionTokens: 0,
    effectiveDate: '2026-09-24',
    lastUpdated: AI_PRICING_LAST_UPDATED,
    sourceUrl: 'https://ollama.com/',
    status: 'FREE_LOCAL'
  }
] as const

function matchesModel(candidate: string, catalogModel: string): boolean {
  if (catalogModel === '*') return true
  const normalized = candidate.toLowerCase()
  const expected = catalogModel.toLowerCase()
  return normalized === expected || normalized.startsWith(`${expected}-`)
}

export function pricingFor(provider: AIUsageProvider, model: string): ModelPricing | undefined {
  return [...BUNDLED_MODEL_PRICING]
    .sort((left, right) => right.model.length - left.model.length)
    .find((entry) => entry.provider === provider && matchesModel(model, entry.model))
}

function cost(tokens: number | undefined, rate: number | undefined): number | undefined {
  if (tokens === undefined || rate === undefined) return undefined
  return (tokens / 1_000_000) * rate
}

export interface CalculatedUsageCost {
  estimatedInputCost?: number
  estimatedOutputCost?: number
  estimatedCachedCost?: number
  estimatedCacheWriteCost?: number
  estimatedTotalCost?: number
  pricing: ModelPricing | undefined
}

export function calculateUsageCost(
  provider: AIUsageProvider,
  model: string,
  usage: AIProviderUsageMetadata
): CalculatedUsageCost {
  const pricing = pricingFor(provider, model)
  if (!pricing) return { pricing: undefined }
  if (pricing.status === 'FREE_LOCAL') {
    return {
      estimatedInputCost: 0,
      estimatedOutputCost: 0,
      estimatedCachedCost: 0,
      estimatedCacheWriteCost: 0,
      estimatedTotalCost: 0,
      pricing
    }
  }

  const cached = usage.cachedInputTokens ?? 0
  const cacheWrite = usage.cacheWriteInputTokens ?? 0
  const input = usage.inputTokens === undefined
    ? undefined
    : Math.max(0, usage.inputTokens - cached - cacheWrite)
  const inputCost = cost(input, pricing.inputPricePerMillionTokens)
  const outputCost = cost(usage.outputTokens, pricing.outputPricePerMillionTokens)
  // If an official cached rate is absent, use the ordinary input rate rather
  // than silently under-counting a request that may still be billable.
  const cachedCost = cached
    ? cost(cached, pricing.cachedInputPricePerMillionTokens ?? pricing.inputPricePerMillionTokens)
    : 0
  const cacheWriteCost = cacheWrite
    ? cost(cacheWrite, pricing.cacheWriteInputPricePerMillionTokens ?? pricing.inputPricePerMillionTokens)
    : 0
  const parts = [inputCost, outputCost, cachedCost, cacheWriteCost]
  const estimatedTotalCost = parts.every((value) => value !== undefined)
    ? parts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined
  return {
    estimatedInputCost: inputCost,
    estimatedOutputCost: outputCost,
    estimatedCachedCost: cachedCost,
    estimatedCacheWriteCost: cacheWriteCost,
    estimatedTotalCost,
    pricing
  }
}

export function estimateCost(input: {
  provider: AIUsageProvider
  model: string
  inputTokens: number
  expectedOutputTokens: number
}): AICostEstimate {
  const calculated = calculateUsageCost(input.provider, input.model, {
    inputTokens: Math.max(0, Math.round(input.inputTokens)),
    outputTokens: Math.max(0, Math.round(input.expectedOutputTokens))
  })
  return {
    ...input,
    inputTokens: Math.max(0, Math.round(input.inputTokens)),
    expectedOutputTokens: Math.max(0, Math.round(input.expectedOutputTokens)),
    estimatedInputCost: calculated.estimatedInputCost,
    estimatedOutputCost: calculated.estimatedOutputCost,
    estimatedTotalCost: calculated.estimatedTotalCost,
    currency: 'USD',
    pricingStatus: calculated.pricing?.status ?? 'UNKNOWN',
    pricingSource: calculated.pricing?.sourceUrl ?? 'Pricing unavailable',
    estimated: true
  }
}
