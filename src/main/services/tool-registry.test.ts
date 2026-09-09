import { describe, expect, it, vi } from 'vitest'

import type { ToolDescriptor } from '../../shared/tool-contracts'
import { ToolRegistry } from './tool-registry'

function browserTool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'browser.open',
    name: 'Open page',
    description: 'Open a secure page in the managed Work browser.',
    connectorId: 'browser',
    modes: ['work'],
    action: 'read',
    confirmation: 'never',
    requiredScopes: [],
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', format: 'https-url', maxLength: 2_048 } },
      required: ['url'],
      additionalProperties: false
    },
    resultSchema: {
      type: 'object',
      properties: { title: { type: 'string', maxLength: 1_000 } },
      required: ['title'],
      additionalProperties: false
    },
    ...overrides
  }
}

describe('ToolRegistry', () => {
  it('lists only tools explicitly enabled for a mode and rejects duplicate IDs', () => {
    const registry = new ToolRegistry()
    registry.register(browserTool(), async () => ({ title: 'Example' }))
    expect(registry.list('work').map((tool) => tool.id)).toEqual(['browser.open'])
    expect(registry.list('code')).toEqual([])
    expect(() => registry.register(browserTool(), async () => null)).toThrow(/already registered/i)
  })

  it('validates HTTPS inputs and never gives executors unsupported fields', async () => {
    const execute = vi.fn(async (input) => ({ title: String(input.url) }))
    const registry = new ToolRegistry()
    registry.register(browserTool(), execute)
    const authorization = { accessLevel: 'read-only' as const, confirm: vi.fn(async () => false) }
    await expect(registry.execute({ toolId: 'browser.open', mode: 'work', input: { url: 'file:///etc/passwd' } }, authorization)).rejects.toThrow(/HTTPS/i)
    await expect(registry.execute({ toolId: 'browser.open', mode: 'work', input: { url: 'https://user:secret@example.com/' } }, authorization)).rejects.toThrow(/credential-free/i)
    const result = await registry.execute({ toolId: 'browser.open', mode: 'work', input: { url: 'https://example.com/' } }, authorization)
    expect(result.result).toEqual({ title: 'https://example.com/' })
    expect(authorization.confirm).not.toHaveBeenCalled()
  })

  it('enforces read-only, ask-before-changes, trusted, and always-confirm policies in the main-process path', async () => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => ({ title: 'done' }))
    registry.register(browserTool({ id: 'browser.type', name: 'Type text', action: 'write', confirmation: 'policy' }), execute)
    const input = { url: 'https://example.com/' }
    await expect(registry.execute({ toolId: 'browser.type', mode: 'work', input }, { accessLevel: 'read-only', confirm: vi.fn() })).rejects.toThrow(/read only/i)
    const cancel = vi.fn(async () => false)
    await expect(registry.execute({ toolId: 'browser.type', mode: 'work', input }, { accessLevel: 'ask-before-changes', confirm: cancel })).rejects.toThrow(/cancelled/i)
    expect(cancel).toHaveBeenCalledOnce()
    const approve = vi.fn(async () => true)
    await registry.execute({ toolId: 'browser.type', mode: 'work', input }, { accessLevel: 'ask-before-changes', confirm: approve })
    await registry.execute({ toolId: 'browser.type', mode: 'work', input }, { accessLevel: 'trusted', confirm: approve })
    expect(approve).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('does not allow a tool registered for Work mode to execute from Code mode', async () => {
    const registry = new ToolRegistry()
    registry.register(browserTool(), async () => ({ title: 'Example' }))
    await expect(registry.execute(
      { toolId: 'browser.open', mode: 'code', input: { url: 'https://example.com/' } },
      { accessLevel: 'trusted', confirm: async () => true }
    )).rejects.toThrow(/not available in code mode/i)
  })
})
