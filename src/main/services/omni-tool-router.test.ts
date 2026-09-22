import { describe, expect, it, vi } from 'vitest'

import type { ToolDescriptor, ToolExecutionResult } from '../../shared/tool-contracts'
import { OmniToolRouter } from './omni-tool-router'

function descriptor(id = 'browser.open', modes: Array<'code' | 'work' | 'omni'> = ['code']): ToolDescriptor {
  return {
    id,
    name: 'Open page',
    description: 'Open one bounded page.',
    connectorId: 'browser',
    modes,
    action: 'read',
    category: 'read',
    risk: 'low',
    reversible: true,
    externalSideEffect: false,
    confirmation: 'never',
    requiredScopes: [],
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', minLength: 1, maxLength: 2_048 } },
      required: ['url'],
      additionalProperties: false
    }
  }
}

function context(executionMode: 'invisible' | 'cursor' = 'invisible') {
  return {
    taskId: 'task-12345678',
    executionMode,
    approvalMode: 'ask' as const,
    signal: new AbortController().signal,
    confirm: vi.fn(async () => true)
  }
}

function result(toolId: string): ToolExecutionResult {
  return {
    toolId,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    result: { ok: true },
    authorization: {
      approvalMode: 'ask', risk: 'low', requiredApproval: false, userApproved: false, reason: 'Read-only.'
    }
  }
}

describe('OmniToolRouter', () => {
  it('projects source tools into Omni without changing the source registry mode', async () => {
    const execute = vi.fn(async (request) => result(request.toolId))
    const router = new OmniToolRouter([{ descriptor: descriptor(), targetMode: 'code', execute }])

    expect(router.list('invisible')).toEqual([expect.objectContaining({ id: 'browser.open', modes: ['omni'] })])
    await expect(router.execute({ toolId: 'browser.open', mode: 'omni', input: { url: 'https://example.com' } }, context()))
      .resolves.toMatchObject({ toolId: 'browser.open', result: { ok: true } })
    expect(execute).toHaveBeenCalledWith(
      { toolId: 'browser.open', mode: 'code', input: { url: 'https://example.com' } },
      expect.objectContaining({ taskId: 'task-12345678' })
    )
  })

  it('uses explicit aliases to resolve colliding Code and Work tool IDs', async () => {
    const code = vi.fn(async (request) => result(request.toolId))
    const work = vi.fn(async (request) => result(request.toolId))
    const router = new OmniToolRouter([
      { descriptor: descriptor('browser.open', ['code']), publicId: 'browser.open', targetMode: 'code', execute: code },
      { descriptor: descriptor('browser.open', ['work']), publicId: 'work-browser.open', targetMode: 'work', execute: work }
    ])
    expect(router.list('invisible').map(({ id }) => id)).toEqual(['browser.open', 'work-browser.open'])
    await router.execute({ toolId: 'work-browser.open', mode: 'omni', input: { url: 'https://example.com' } }, context())
    expect(work).toHaveBeenCalledWith(expect.objectContaining({ toolId: 'browser.open', mode: 'work' }), expect.anything())
    expect(code).not.toHaveBeenCalled()
  })

  it('can route a dedicated Omni-native registry without projecting it through Code or Work', async () => {
    const execute = vi.fn(async (request) => result(request.toolId))
    const router = new OmniToolRouter([{ descriptor: descriptor('browser.open', ['omni']), targetMode: 'omni', execute }])
    await router.execute({ toolId: 'browser.open', mode: 'omni', input: { url: 'https://example.com' } }, context())
    expect(execute).toHaveBeenCalledWith(
      { toolId: 'browser.open', mode: 'omni', input: { url: 'https://example.com' } },
      expect.anything()
    )
  })

  it('rejects duplicate IDs, invalid aliases, unknown tools, and non-Omni requests', async () => {
    const execute = vi.fn(async (request) => result(request.toolId))
    const router = new OmniToolRouter([{ descriptor: descriptor(), targetMode: 'code', execute }])
    expect(() => router.register({ descriptor: descriptor(), targetMode: 'code', execute })).toThrow(/already registered/i)
    expect(() => new OmniToolRouter([{ descriptor: descriptor(), publicId: 'not valid', targetMode: 'code', execute }])).toThrow(/connector\.action/i)
    await expect(router.execute({ toolId: 'missing.tool', mode: 'omni', input: {} }, context())).rejects.toThrow(/not registered/i)
    await expect(router.execute({ toolId: 'browser.open', mode: 'work', input: {} }, context())).rejects.toThrow(/only Omni/i)
  })

  it('keeps Cursor-only tools unavailable in Invisible Mode', async () => {
    const execute = vi.fn(async (request) => result(request.toolId))
    const router = new OmniToolRouter([{
      descriptor: descriptor('computer.click'), targetMode: 'code', executionModes: ['cursor'], execute
    }])
    expect(router.list('invisible')).toEqual([])
    expect(router.list('cursor')).toHaveLength(1)
    await expect(router.execute({ toolId: 'computer.click', mode: 'omni', input: { url: 'ignored' } }, context('invisible')))
      .rejects.toThrow(/not available in Invisible/i)
    expect(execute).not.toHaveBeenCalled()
  })

  it('stops before routing and rejects a mismatched source result', async () => {
    const aborted = new AbortController()
    aborted.abort(new DOMException('Stopped', 'AbortError'))
    const execute = vi.fn(async () => result('wrong.tool'))
    const router = new OmniToolRouter([{ descriptor: descriptor(), targetMode: 'code', execute }])
    await expect(router.execute({ toolId: 'browser.open', mode: 'omni', input: { url: 'x' } }, {
      ...context(), signal: aborted.signal
    })).rejects.toThrow(/Stopped/i)
    expect(execute).not.toHaveBeenCalled()
    await expect(router.execute({ toolId: 'browser.open', mode: 'omni', input: { url: 'x' } }, context()))
      .rejects.toThrow(/wrong tool/i)
  })
})
