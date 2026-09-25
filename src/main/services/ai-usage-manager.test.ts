import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AIUsageBudgetExceededError, AIUsageManager } from './ai-usage-manager'
import { AIManager } from './ai-manager'
import type { CredentialManager } from './credential-manager'
import { WorkspaceIndexer } from './workspace-indexer'

const temporaryDirectories: string[] = []

async function manager(now = Date.parse('2026-09-24T12:00:00Z')): Promise<{ usage: AIUsageManager; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnicode-ai-usage-'))
  temporaryDirectories.push(directory)
  return { usage: new AIUsageManager(path.join(directory, 'usage.sqlite'), { now: () => now }), directory }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('AIUsageManager', () => {
  it('persists provider metadata and returns real aggregates', async () => {
    const { usage } = await manager()
    usage.record({
      provider: 'openai', model: 'gpt-5-mini', context: { mode: 'code', feature: 'chat', conversationId: 'conversation-123' },
      usage: { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 400, totalTokens: 1_200 },
      latencyMs: 450, success: true
    })
    usage.record({
      provider: 'ollama', model: 'qwen2.5-coder:7b', context: { mode: 'omni', feature: 'voice' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, latencyMs: 125, success: true
    })
    const summary = usage.summary({ granularity: 'day' })
    expect(summary.totals).toMatchObject({ requests: 2, inputTokens: 1100, outputTokens: 220, totalTokens: 1320, pricedRequests: 2, failedRequests: 0 })
    expect(summary.local.estimatedCost).toBe(0)
    expect(summary.cloud.estimatedCost).toBeGreaterThan(0)
    expect(summary.providers.map((item) => item.provider)).toEqual(expect.arrayContaining(['openai', 'ollama']))
    expect(summary.recent[0]).not.toHaveProperty('prompt')
    usage.close()
  })

  it('keeps unknown prices honest and blocks hard budgets conservatively', async () => {
    const { usage } = await manager()
    usage.updateSettings({ retentionDays: 365, budgets: { dailyUsd: 0.01, warningThresholds: [75, 90, 100], hardStop: true, largeRequestWarningUsd: 0.25 } })
    expect(() => usage.assertWithinBudget(usage.estimateRequest({ provider: 'openai', model: 'gpt-5', inputTokens: 1_000_000, expectedOutputTokens: 1_000_000 })))
      .toThrow(AIUsageBudgetExceededError)
    usage.close()
  })

  it('exports metadata without message content or credentials', async () => {
    const { usage, directory } = await manager()
    usage.record({
      provider: 'google', model: 'gemini-3.6-flash', context: { mode: 'work', feature: 'tool-planning', taskId: 'opaque-task-id' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, latencyMs: 42, success: false, errorType: 'HTTP_429'
    })
    const exported = usage.exportData('json')
    const exportPath = path.join(directory, 'usage.json')
    await import('node:fs/promises').then((fs) => fs.writeFile(exportPath, exported.content))
    const text = await readFile(exportPath, 'utf8')
    expect(text).toContain('opaque-task-id')
    expect(text).not.toMatch(/prompt|authorization|api.?key/iu)
    usage.close()
  })

  it('records real OpenAI response metadata at the shared AIManager boundary', async () => {
    const { usage } = await manager()
    const credentials = { get: async () => 'test-secret-that-must-not-be-persisted' } as unknown as CredentialManager
    const fetchMock = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Tracked response' } }],
      usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62, prompt_tokens_details: { cached_tokens: 20 } }
    }), { status: 200, headers: { 'x-ratelimit-remaining-requests': '99' } })) as typeof fetch
    const ai = new AIManager(credentials, new WorkspaceIndexer(), async () => ({
      platform: 'darwin', architecture: 'arm64', appleSilicon: true, cpuModel: 'Test Mac', logicalCores: 8,
      memoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3, metalSupported: true
    }), { fetch: fetchMock, usageManager: usage })

    await expect(ai.chat({
      provider: 'openai', model: 'gpt-5-mini', usageContext: { mode: 'work', feature: 'chat', conversationId: 'conversation-abc' },
      messages: [{ role: 'user', content: 'This content is never persisted.' }]
    })).resolves.toMatchObject({ content: 'Tracked response' })

    const records = usage.records()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ provider: 'openai', model: 'gpt-5-mini', mode: 'work', inputTokens: 50, outputTokens: 12, cachedInputTokens: 20, totalTokens: 62 })
    expect(JSON.stringify(records)).not.toContain('This content is never persisted.')
    expect(JSON.stringify(records)).not.toContain('test-secret-that-must-not-be-persisted')
    usage.close()
  })

  it('requires confirmation for a request above the configured estimate before network use', async () => {
    const { usage } = await manager()
    usage.updateSettings({ retentionDays: 365, budgets: { warningThresholds: [75, 90, 100], hardStop: false, largeRequestWarningUsd: 0.001 } })
    let fetchCalls = 0
    const ai = new AIManager({ get: async () => 'test-key' } as unknown as CredentialManager, new WorkspaceIndexer(), async () => ({
      platform: 'darwin', architecture: 'arm64', appleSilicon: true, cpuModel: 'Test Mac', logicalCores: 8,
      memoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3, metalSupported: true
    }), {
      usageManager: usage,
      confirmLargeRequest: async () => false,
      fetch: (async () => { fetchCalls++; return new Response('{}') }) as typeof fetch
    })
    await expect(ai.chat({ provider: 'openai', model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Confirm first' }] }))
      .rejects.toThrow('cancelled before sending')
    expect(fetchCalls).toBe(0)
    expect(usage.records()).toHaveLength(0)
    usage.close()
  })
})
