import { describe, expect, it } from 'vitest'

import { ProviderPolicyManager } from './provider-policy-manager'

describe('ProviderPolicyManager', () => {
  const policies = new ProviderPolicyManager()

  it('allows documented API and local paths for minimum Google Workspace context', () => {
    expect(policies.policyFor('openai', 'gpt-test')).toMatchObject({
      allowsGoogleWorkspaceData: true, cloud: true, endpointType: 'OpenAI API Chat Completions endpoint'
    })
    expect(policies.policyFor('anthropic', 'claude-test')).toMatchObject({
      allowsGoogleWorkspaceData: true, cloud: true, endpointType: 'Anthropic commercial API Messages endpoint'
    })
    expect(policies.policyFor('ollama', 'qwen3:8b')).toMatchObject({
      allowsGoogleWorkspaceData: true, cloud: false, dataRegion: 'On this Mac.'
    })
  })

  it('blocks provider configurations whose compatible data handling cannot be verified', () => {
    expect(policies.policyFor('google', 'gemini-test')).toMatchObject({
      allowsGoogleWorkspaceData: false, cloud: true
    })
    expect(policies.policyFor('ollama', 'gpt-oss:120b-cloud')).toMatchObject({
      allowsGoogleWorkspaceData: false, cloud: true
    })
    expect(() => policies.assertGoogleWorkspaceTransferAllowed('google', 'gemini-test'))
      .toThrow(/not approved for Google Workspace content/i)
  })

  it('keeps auditable documentation and review dates with every decision', () => {
    for (const provider of ['ollama', 'openai', 'anthropic', 'google'] as const) {
      const policy = policies.policyFor(provider, provider === 'ollama' ? 'local-model' : `${provider}-model`)
      expect(policy.lastReviewed).toBe('2026-09-23')
      expect(policy.documentationUrls.length).toBeGreaterThan(1)
      expect(policy.documentationUrls.every((url) => url.startsWith('https://'))).toBe(true)
      expect(policy.training).toBeTruthy()
      expect(policy.retention).toBeTruthy()
    }
  })
})
