import { describe, expect, it, vi } from 'vitest'

import type { OmniCursorService, OmniCursorSession } from './omni-cursor-service'
import { OmniComputerToolService } from './omni-computer-tool-service'
import { ToolRegistry } from './tool-registry'

function setup() {
  const session = {
    state: 'active',
    observe: vi.fn(async () => ({ cursor: { x: 1, y: 2 }, frontmostApplication: null, frontmostWindow: null, observedAt: 1 })),
    move: vi.fn(async () => ({ observation: { cursor: { x: 3, y: 4 }, frontmostApplication: null, frontmostWindow: null, observedAt: 2 } })),
    click: vi.fn(async () => ({ observation: { cursor: { x: 3, y: 4 }, frontmostApplication: null, frontmostWindow: null, observedAt: 3 } })),
    doubleClick: vi.fn(), scroll: vi.fn(), typeText: vi.fn(), pressKey: vi.fn(), focusApplication: vi.fn(),
    resume: vi.fn(async () => undefined), dispose: vi.fn()
  }
  const cursor = {
    listApplications: vi.fn(() => [{ id: 'finder', name: 'Finder' }]),
    startSession: vi.fn(async () => session)
  } as unknown as OmniCursorService
  const service = new OmniComputerToolService({ cursor })
  const registry = new ToolRegistry()
  service.register(registry)
  return { cursor, service, session: session as unknown as OmniCursorSession & typeof session, registry }
}

const full = { accessLevel: 'trusted' as const, approvalMode: 'full' as const, confirm: vi.fn(async () => true) }

describe('OmniComputerToolService', () => {
  it('registers only a closed structured Omni computer catalog', () => {
    const { registry } = setup()
    expect(registry.list('omni').map((tool) => tool.id)).toEqual([
      'computer.observe', 'computer.move', 'computer.click', 'computer.double-click',
      'computer.scroll', 'computer.type-text', 'computer.press-key', 'computer.focus-app'
    ])
    expect(registry.list('code')).toEqual([])
  })

  it('keeps pointer clicks directly confirmed even in Full Access mode', async () => {
    const { registry, session } = setup()
    const confirm = vi.fn(async () => true)
    await registry.execute(
      { toolId: 'computer.click', mode: 'omni', input: { button: 'left' } },
      { ...full, confirm },
      { executionId: 'task-1' }
    )
    expect(confirm).toHaveBeenCalledOnce()
    expect(session.click).toHaveBeenCalledWith({ button: 'left' }, expect.any(AbortSignal))
  })

  it('allows read-only observation without approval and binds the native session to one task', async () => {
    const { cursor, registry } = setup()
    const confirm = vi.fn(async () => false)
    const result = await registry.execute(
      { toolId: 'computer.observe', mode: 'omni', input: {} },
      { accessLevel: 'trusted', approvalMode: 'ask', confirm },
      { executionId: 'task-1' }
    )
    await registry.execute(
      { toolId: 'computer.observe', mode: 'omni', input: {} },
      { accessLevel: 'trusted', approvalMode: 'ask', confirm },
      { executionId: 'task-1' }
    )
    expect(result.result).toMatchObject({ cursor: { x: 1, y: 2 } })
    expect(confirm).not.toHaveBeenCalled()
    expect(cursor.startSession).toHaveBeenCalledOnce()
  })

  it('refuses to type credential-looking text even after direct approval', async () => {
    const { registry, session } = setup()
    await expect(registry.execute(
      { toolId: 'computer.type-text', mode: 'omni', input: { text: 'Authorization: Bearer secret-token-123456' } },
      full,
      { executionId: 'task-1' }
    )).rejects.toThrow(/never types credentials/i)
    expect(session.typeText).not.toHaveBeenCalled()
  })

  it('disposes task-owned cursor control during cleanup', async () => {
    const { registry, service, session } = setup()
    await registry.execute({ toolId: 'computer.observe', mode: 'omni', input: {} }, full, { executionId: 'task-1' })
    await service.cleanupTask('task-1')
    expect(session.dispose).toHaveBeenCalledOnce()
  })
})
