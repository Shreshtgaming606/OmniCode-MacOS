import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderPolicyManager } from './provider-policy-manager'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function manager(options: { key?: string; now?: number; connected?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnicode-provider-policy-'))
  directories.push(directory)
  let key = options.key ?? 'gemini-test-key'
  const now = options.now ?? Date.parse('2026-09-23T12:00:00.000Z')
  const policies = new ProviderPolicyManager({
    settingsPath: path.join(directory, 'policy.json'),
    getCredential: async (provider) => provider === 'google' ? key : `${provider}-test-key`,
    testProviderConnection: vi.fn(async () => ({ state: options.connected === false ? 'unavailable' : 'connected' })),
    now: () => now
  })
  return { policies, directory, rotateKey: (value: string) => { key = value } }
}

describe('ProviderPolicyManager', () => {
  it('keeps unknown and explicitly free Gemini configurations closed', async () => {
    const { policies } = await manager()
    await expect(policies.policyFor('google', 'gemini-test')).resolves.toMatchObject({
      verificationState: 'UNKNOWN', workspaceDataEligible: false, allowsGoogleWorkspaceData: false, plan: 'unknown'
    })
    await policies.configureGeminiWorkspace({ plan: 'free' })
    await expect(policies.policyFor('google', 'gemini-test')).resolves.toMatchObject({
      verificationState: 'INELIGIBLE', workspaceDataEligible: false, allowsGoogleWorkspaceData: false, plan: 'free'
    })
  })

  it('requires both AI Studio confirmations and a real credential connection before recording Paid', async () => {
    const { policies } = await manager()
    await expect(policies.configureGeminiWorkspace({ plan: 'paid' })).rejects.toThrow(/Confirm both/u)
    const unavailable = await manager({ connected: false })
    await expect(unavailable.policies.configureGeminiWorkspace({
      plan: 'paid', confirmedAiStudioPlan: true, confirmedMatchingCredential: true
    })).rejects.toThrow(/pass Test Connection/u)
  })

  it('allows verified Paid Gemini only after separate connected-data consent', async () => {
    const { policies } = await manager()
    await policies.configureGeminiWorkspace({
      plan: 'paid', confirmedAiStudioPlan: true, confirmedMatchingCredential: true
    })
    await expect(policies.policyFor('google', 'gemini-test')).resolves.toMatchObject({
      verificationState: 'VERIFIED_ELIGIBLE', workspaceDataEligible: true,
      consentGranted: false, allowsGoogleWorkspaceData: false, plan: 'paid', zeroDataRetention: 'not-configured'
    })
    await policies.setGoogleWorkspaceConsent('google', true)
    await expect(policies.policyFor('google', 'gemini-test')).resolves.toMatchObject({
      verificationState: 'VERIFIED_ELIGIBLE', consentGranted: true, allowsGoogleWorkspaceData: true
    })
  })

  it('invalidates eligibility and consent when the saved Gemini credential changes', async () => {
    const { policies, rotateKey } = await manager()
    await policies.configureGeminiWorkspace({
      plan: 'paid', confirmedAiStudioPlan: true, confirmedMatchingCredential: true
    })
    await policies.setGoogleWorkspaceConsent('google', true)
    rotateKey('replacement-key')
    await expect(policies.policyFor('google')).resolves.toMatchObject({
      verificationState: 'UNKNOWN', consentGranted: false, allowsGoogleWorkspaceData: false
    })
  })

  it('expires manual Gemini eligibility after seven days', async () => {
    const start = Date.parse('2026-09-23T12:00:00.000Z')
    const first = await manager({ now: start })
    await first.policies.configureGeminiWorkspace({
      plan: 'paid', confirmedAiStudioPlan: true, confirmedMatchingCredential: true
    })
    const later = new ProviderPolicyManager({
      settingsPath: path.join(first.directory, 'policy.json'),
      getCredential: async () => 'gemini-test-key',
      now: () => start + 8 * 24 * 60 * 60 * 1_000
    })
    await expect(later.policyFor('google')).resolves.toMatchObject({
      verificationState: 'UNVERIFIED', workspaceDataEligible: false, allowsGoogleWorkspaceData: false
    })
  })

  it('binds cloud consent to provider credentials without storing credentials', async () => {
    const { policies, directory } = await manager()
    await expect(policies.policyFor('openai')).resolves.toMatchObject({
      verificationState: 'VERIFIED_ELIGIBLE', workspaceDataEligible: true, allowsGoogleWorkspaceData: false
    })
    await policies.setGoogleWorkspaceConsent('openai', true)
    await expect(policies.policyFor('openai')).resolves.toMatchObject({ consentGranted: true, allowsGoogleWorkspaceData: true })
    const stored = await readFile(path.join(directory, 'policy.json'), 'utf8')
    expect(stored).not.toContain('openai-test-key')
    expect(stored).not.toContain('gemini-test-key')
  })

  it('fails closed instead of crashing on a corrupt policy file', async () => {
    const { directory } = await manager()
    const settingsPath = path.join(directory, 'corrupt-policy.json')
    await writeFile(settingsPath, '{not valid json', { encoding: 'utf8', mode: 0o600 })
    const policies = new ProviderPolicyManager({
      settingsPath,
      getCredential: async () => 'gemini-test-key'
    })
    await expect(policies.policyFor('google')).resolves.toMatchObject({
      verificationState: 'UNKNOWN', workspaceDataEligible: false,
      consentGranted: false, allowsGoogleWorkspaceData: false
    })
  })

  it('keeps local Ollama eligible without cloud consent and blocks cloud-routed Ollama models', async () => {
    const { policies } = await manager()
    await expect(policies.policyFor('ollama', 'qwen3:8b')).resolves.toMatchObject({
      allowsGoogleWorkspaceData: true, cloud: false, dataRegion: 'On this Mac.'
    })
    await expect(policies.policyFor('ollama', 'gpt-oss:120b-cloud')).resolves.toMatchObject({
      verificationState: 'UNVERIFIED', allowsGoogleWorkspaceData: false, cloud: true
    })
  })

  it('keeps auditable documentation and review dates with every decision', async () => {
    const { policies } = await manager()
    for (const provider of ['ollama', 'openai', 'anthropic', 'google'] as const) {
      const policy = await policies.policyFor(provider, provider === 'ollama' ? 'local-model' : `${provider}-model`)
      expect(policy.lastReviewed).toBe('2026-09-23')
      expect(policy.documentationUrls.length).toBeGreaterThan(1)
      expect(policy.documentationUrls.every((url) => url.startsWith('https://'))).toBe(true)
      expect(policy.training).toBeTruthy()
      expect(policy.retention).toBeTruthy()
    }
  })
})
