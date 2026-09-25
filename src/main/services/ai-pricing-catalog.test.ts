import { describe, expect, it } from 'vitest'

import { calculateUsageCost, estimateCost, pricingFor } from './ai-pricing-catalog'

describe('AI pricing catalog', () => {
  it('uses the narrowest matching model family and cached-input rate', () => {
    expect(pricingFor('openai', 'gpt-5-mini-2026-08-01')?.model).toBe('gpt-5-mini')
    const calculated = calculateUsageCost('openai', 'gpt-4.1-mini', {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 100_000
    })
    expect(calculated.estimatedInputCost).toBeCloseTo(0.2)
    expect(calculated.estimatedCachedCost).toBeCloseTo(0.05)
    expect(calculated.estimatedOutputCost).toBeCloseTo(0.16)
    expect(calculated.estimatedTotalCost).toBeCloseTo(0.41)
  })

  it('reports every Ollama model as zero API cost', () => {
    expect(estimateCost({ provider: 'ollama', model: 'qwen2.5-coder:7b', inputTokens: 1000, expectedOutputTokens: 500 }))
      .toMatchObject({ estimatedTotalCost: 0, pricingStatus: 'FREE_LOCAL' })
  })

  it('does not invent pricing for an unknown cloud model', () => {
    expect(estimateCost({ provider: 'google', model: 'future-model', inputTokens: 1000, expectedOutputTokens: 500 }))
      .toMatchObject({ estimatedTotalCost: undefined, pricingStatus: 'UNKNOWN', pricingSource: 'Pricing unavailable' })
  })
})
