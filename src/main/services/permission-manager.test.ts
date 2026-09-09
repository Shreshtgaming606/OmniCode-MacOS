import { describe, expect, it, vi } from 'vitest'

import type { ToolDescriptor } from '../../shared/tool-contracts'
import { PermissionManager } from './permission-manager'

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'mail.send',
    name: 'Send message',
    description: 'Send one message.',
    connectorId: 'mail',
    modes: ['work'],
    action: 'write',
    confirmation: 'policy',
    requiredScopes: [],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...overrides
  }
}

describe('PermissionManager', () => {
  it('lets the connector access policy override a tool that requests no confirmation', async () => {
    const confirm = vi.fn(async () => true)
    await new PermissionManager().authorize(
      tool({ confirmation: 'never' }),
      {},
      { accessLevel: 'ask-before-changes', confirm }
    )
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('blocks every non-read action on read-only connectors before confirmation', async () => {
    const confirm = vi.fn(async () => true)
    await expect(new PermissionManager().authorize(
      tool({ action: 'sensitive', confirmation: 'always' }),
      {},
      { accessLevel: 'read-only', confirm }
    )).rejects.toThrow(/read only/i)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('always confirms destructive and sensitive actions even for trusted connectors', async () => {
    for (const action of ['destructive', 'sensitive'] as const) {
      const confirm = vi.fn(async () => true)
      await new PermissionManager().authorize(
        tool({ action, confirmation: 'never' }),
        {},
        { accessLevel: 'trusted', confirm }
      )
      expect(confirm).toHaveBeenCalledOnce()
    }
  })

  it('requires an explicit boolean approval and rejects invalid authorization contexts', async () => {
    await expect(new PermissionManager().authorize(
      tool({ confirmation: 'always' }),
      {},
      { accessLevel: 'trusted', confirm: async () => 'yes' as unknown as boolean }
    )).rejects.toThrow(/cancelled/i)

    await expect(new PermissionManager().authorize(
      tool(),
      {},
      { accessLevel: 'invalid' as 'trusted', confirm: async () => true }
    )).rejects.toThrow(/policy is invalid/i)
  })
})
