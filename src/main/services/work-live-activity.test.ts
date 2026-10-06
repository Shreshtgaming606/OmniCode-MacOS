import { describe, expect, it, vi } from 'vitest'

import type { AIManager } from './ai-manager'
import { WorkAgentManager } from './work-agent-manager'
import type { WorkToolActivity } from '../../shared/work-contracts'

describe('WorkAgentManager live activity', () => {
  it.each([
    ['ollama', 'Ollama'],
    ['openai', 'OpenAI'],
    ['anthropic', 'Claude'],
    ['google', 'Gemini']
  ] as const)('emits provider-independent live status for %s', async (provider, displayName) => {
    const chat = vi.fn(async () => ({ content: 'Done.', contextFiles: [] }))
    const activity: WorkToolActivity[] = []
    const response = await new WorkAgentManager({ chat } as unknown as AIManager).chat({
      provider, model: `${provider}-model`, messages: [{ role: 'user', content: 'Summarize this.' }]
    }, [], vi.fn(), { onToolActivity: (event) => activity.push(event) })

    expect(response.content).toBe('Done.')
    expect(response.toolActivities).toEqual([])
    expect(activity).toMatchObject([
      { toolId: 'provider.request', name: `Waiting for ${displayName}`, status: 'running' },
      { toolId: 'provider.request', name: `Waiting for ${displayName}`, status: 'succeeded' },
      { toolId: 'response.prepare', name: 'Preparing response', status: 'running' },
      { toolId: 'response.prepare', name: 'Preparing response', status: 'succeeded' }
    ])
  })

  it('records a provider failure without exposing a credential', async () => {
    const chat = vi.fn(async () => { throw new Error('Authorization: Bearer private-token') })
    const activity: WorkToolActivity[] = []
    await expect(new WorkAgentManager({ chat } as unknown as AIManager).chat({
      provider: 'openai', model: 'gpt-test', messages: [{ role: 'user', content: 'Hello' }]
    }, [], vi.fn(), { onToolActivity: (event) => activity.push(event) })).rejects.toThrow()

    expect(activity.at(-1)).toMatchObject({ toolId: 'provider.request', status: 'failed' })
    expect(activity.at(-1)?.summary).not.toContain('private-token')
  })
})
