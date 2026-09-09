import { describe, expect, it } from 'vitest'

import type { AIModel } from '../../../../shared/contracts'
import { conversationTitle, humanizeWorkError, localModelDescriptor } from './WorkMode'

describe('WorkMode helpers', () => {
  it('creates bounded single-line conversation titles from the first real message', () => {
    expect(conversationTitle('  Plan\n a   launch  ')).toBe('Plan a launch')
    expect(conversationTitle('x'.repeat(100))).toHaveLength(60)
    expect(conversationTitle('   ')).toBe('New chat')
  })

  it('normalizes installed Ollama models without fabricating unsupported capabilities', () => {
    const descriptor = localModelDescriptor({
      id: 'qwen-test:latest',
      name: 'Qwen Test',
      provider: 'ollama',
      local: true,
      installed: true,
      toolUse: false,
      capabilities: ['completion'],
      codingCapability: 'Strong'
    } satisfies AIModel)

    expect(descriptor).toMatchObject({
      id: 'qwen-test:latest', provider: 'ollama', local: true, availability: 'available',
      capabilities: {
        chat: { support: 'supported' },
        coding: { support: 'supported' },
        'tool-calling': { support: 'unknown' },
        vision: { support: 'unknown' }
      }
    })
  })

  it('turns bounded provider JSON into a useful message without IPC wrapper noise', () => {
    expect(humanizeWorkError(new Error(
      `Error invoking remote method 'ai:chat': Error: AI provider returned 404: ${JSON.stringify({ error: { message: 'Choose a current model.' } })}`
    ))).toBe('Choose a current model. (HTTP 404)')
  })
})
