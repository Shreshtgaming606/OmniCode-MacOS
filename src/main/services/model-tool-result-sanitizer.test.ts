import { describe, expect, it } from 'vitest'

import { sanitizeToolResultForModel, serializeToolResultForModel } from './model-tool-result-sanitizer'

describe('model tool-result secret boundary', () => {
  it('redacts nested credential fields and secret-looking values in generic text', () => {
    const sanitized = sanitizeToolResultForModel({
      password: 'do-not-send',
      credentials: { value: 'nested-secret', label: 'Service login' },
      cookies: [{ name: 'session', value: 'cookie-secret' }],
      body: 'Authorization: Bearer token-value-123456; api_key=sk-proj-example1234567890',
      url: 'https://example.test/path?access_token=ya29.exampletokenvalue1234567890&view=summary',
      providerText: 'Google key AIzaExampleValue123456789012345678 and GitHub ghp_exampletoken1234567890'
    })
    const serialized = JSON.stringify(sanitized)

    for (const secret of [
      'do-not-send', 'nested-secret', 'cookie-secret', 'token-value-123456',
      'sk-proj-example1234567890', 'ya29.exampletokenvalue1234567890',
      'AIzaExampleValue123456789012345678', 'ghp_exampletoken1234567890'
    ]) expect(serialized).not.toContain(secret)
    expect(serialized).toContain('[REDACTED_SECRET]')
    expect(serialized).toContain('view=summary')
  })

  it('preserves ordinary useful text and similarly named non-secret fields', () => {
    expect(sanitizeToolResultForModel({
      title: 'Token-count optimization',
      tokenCount: 128,
      description: 'API keys should be stored securely; no credential value is included.',
      content: 'Build completed successfully.'
    })).toEqual({
      title: 'Token-count optimization',
      tokenCount: 128,
      description: 'API keys should be stored securely; no credential value is included.',
      content: 'Build completed successfully.'
    })
  })

  it('bounds serialized model content and rejects invalid size limits', () => {
    expect(() => serializeToolResultForModel({ text: 'x'.repeat(2_000) }, 200)).toThrow(/too large/i)
    expect(() => serializeToolResultForModel({ ok: true }, 0)).toThrow(/size limit/i)
  })
})
