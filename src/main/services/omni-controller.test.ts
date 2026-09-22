import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OmniStartRequest } from '../../shared/omni-contracts'
import type { ToolDescriptor, ToolExecutionRequest, ToolExecutionResult } from '../../shared/tool-contracts'
import { OmniController } from './omni-controller'
import { OmniTaskStore } from './omni-task-store'
import { OmniToolRouter, type OmniToolRoute, type OmniToolRouteContext } from './omni-tool-router'
import type { WorkAgentManager } from './work-agent-manager'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function store(): Promise<OmniTaskStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnicode-omni-controller-'))
  temporaryDirectories.push(directory)
  return new OmniTaskStore(path.join(directory, 'tasks.json'))
}

function request(changes: Partial<OmniStartRequest> = {}): OmniStartRequest {
  return {
    provider: 'google',
    model: 'gemini-test',
    input: 'Inspect the current project and report the result.',
    activationSource: 'main-window',
    executionMode: 'invisible',
    approvalMode: 'ask',
    ...changes
  }
}

function planInput() {
  return {
    updateType: 'initial',
    taskUnderstanding: 'Inspect the project',
    reasoningSummary: 'I will inspect the project, verify what I find, and report the result.',
    steps: ['Inspect the project', 'Verify the result'],
    completedSteps: 0,
    currentStep: 'Inspect the project',
    nextStep: 'Verify the result',
    assumptions: []
  }
}

function readDescriptor(): ToolDescriptor {
  return {
    id: 'files.list', name: 'List workspace files', description: 'List bounded workspace files.', connectorId: 'workspace',
    modes: ['code'], action: 'read', category: 'read', risk: 'low', reversible: true, externalSideEffect: false,
    confirmation: 'never', requiredScopes: [], inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
}

function successful(toolId: string): ToolExecutionResult {
  return {
    toolId,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    result: { files: ['src/index.ts'] },
    authorization: { approvalMode: 'ask', risk: 'low', requiredApproval: false, userApproved: false, reason: 'Read-only.' }
  }
}

function router(execute: OmniToolRoute['execute'] = vi.fn(async (toolRequest) => successful(toolRequest.toolId))): OmniToolRouter {
  return new OmniToolRouter([{ descriptor: readDescriptor(), targetMode: 'code', execute }])
}

async function waitForTask(controller: OmniController, taskId: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = await controller.get(taskId)
    if (task.status === status) return task
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Omni task did not reach ${status}.`)
}

describe('OmniController', () => {
  it('requires a visible plan before a real tool, records verified activity, and completes', async () => {
    const taskStore = await store()
    const speak = vi.fn()
    const routed = vi.fn(async (toolRequest) => successful(toolRequest.toolId))
    const agent = {
      chat: vi.fn(async (_request, tools, execute, options) => {
        expect(tools.map((tool: ToolDescriptor) => tool.id)).toEqual(['omni.update-plan', 'files.list'])
        await options.beforeAction?.()
        await execute({ toolId: 'omni.update-plan', mode: 'omni', input: planInput() })
        await options.beforeAction?.()
        await execute({ toolId: 'files.list', mode: 'omni', input: {} })
        return { content: 'Done. The project was inspected.', toolActivities: [], toolCallCount: 2 }
      })
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore,
      agent,
      createRouter: async () => router(routed),
      confirm: vi.fn(async () => true),
      onSpeak: speak
    })

    const started = await controller.start(request())
    const completed = await waitForTask(controller, started.id, 'completed')
    expect(completed.plan).toMatchObject({ updatedBy: 'agent', reasoningSummary: expect.stringContaining('inspect the project') })
    expect(completed.resultSummary).toBe('Done. The project was inspected.')
    expect(completed.events.map((event) => [event.kind, event.status])).toEqual(expect.arrayContaining([
      ['plan', 'succeeded'], ['file', 'succeeded'], ['result', 'succeeded']
    ]))
    expect(JSON.stringify(completed)).not.toContain('src/index.ts')
    expect(routed).toHaveBeenCalledOnce()
    expect(speak).toHaveBeenCalledWith(started.id, expect.stringContaining('inspect the project'))
    expect(speak).toHaveBeenCalledWith(started.id, 'Done. The project was inspected.')
  })

  it('blocks an external action when the model skipped the required plan', async () => {
    const taskStore = await store()
    const routed = vi.fn(async (toolRequest) => successful(toolRequest.toolId))
    const agent = {
      chat: vi.fn(async (_request, _tools, execute) => {
        await execute({ toolId: 'files.list', mode: 'omni', input: {} })
        return { content: 'should not complete', toolActivities: [], toolCallCount: 1 }
      })
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore, agent, createRouter: async () => router(routed), confirm: vi.fn(async () => true)
    })
    const started = await controller.start(request())
    const failed = await waitForTask(controller, started.id, 'failed')
    expect(failed.error).toMatch(/update its visible plan/i)
    expect(routed).not.toHaveBeenCalled()
  })

  it('does not mark a task complete while a tool failure remains unresolved', async () => {
    const taskStore = await store()
    const agent = {
      chat: vi.fn(async () => ({
        content: 'I could not finish the requested action.',
        toolCallCount: 1,
        toolActivities: [{
          id: 'failed-action', toolId: 'files.list', name: 'List workspace files', connectorId: 'workspace',
          status: 'failed', createdAt: Date.now(), completedAt: Date.now(), summary: 'List workspace files failed safely.'
        }]
      }))
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore, agent, createRouter: async () => router(), confirm: vi.fn(async () => true)
    })

    const started = await controller.start(request())
    const failed = await waitForTask(controller, started.id, 'failed')
    expect(failed.error).toMatch(/did not complete/i)
    expect(failed.resultSummary).toBeUndefined()
  })

  it('keeps unsupported local models in honest chat-only mode without exposing tools', async () => {
    const taskStore = await store()
    const agent = {
      chat: vi.fn(async (_request, tools) => {
        expect(tools).toEqual([])
        return { content: 'I need a tool-capable model to control the Mac.', toolActivities: [], toolCallCount: 0 }
      })
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore,
      agent,
      createRouter: async () => router(),
      canUseTools: async () => false,
      confirm: vi.fn(async () => true)
    })
    const started = await controller.start(request({ provider: 'ollama', model: 'chat-only' }))
    const completed = await waitForTask(controller, started.id, 'completed')
    expect(completed.resultSummary).toMatch(/tool-capable model/i)
    expect(completed.events[0].summary).toMatch(/not verified for Omni tools/i)
  })

  it('supports pause, resume, execution-mode switching, and immediate stop boundaries', async () => {
    const taskStore = await store()
    let releaseAfterPlan!: () => void
    const afterPlan = new Promise<void>((resolve) => { releaseAfterPlan = resolve })
    let planFinished!: () => void
    const planReady = new Promise<void>((resolve) => { planFinished = resolve })
    const agent = {
      chat: vi.fn(async (_request, _tools, execute, options) => {
        await execute({ toolId: 'omni.update-plan', mode: 'omni', input: planInput() })
        planFinished()
        await afterPlan
        await options.beforeAction?.()
        if (options.signal?.aborted) throw options.signal.reason
        await execute({ toolId: 'files.list', mode: 'omni', input: {} })
        return { content: 'Done.', toolActivities: [], toolCallCount: 2 }
      })
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore, agent, createRouter: async () => router(), confirm: vi.fn(async () => true)
    })
    const started = await controller.start(request())
    await planReady
    await controller.pause(started.id)
    await controller.switchExecutionMode(started.id, 'cursor')
    expect((await controller.get(started.id)).executionMode).toBe('cursor')
    releaseAfterPlan()
    await waitForTask(controller, started.id, 'paused')
    await controller.resume(started.id)
    // Switching modes requires a revised plan before more actions. Stopping at
    // this boundary must prevent that already-proposed stale action.
    const stopped = await controller.stop(started.id)
    expect(stopped.status).toBe('stopped')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await controller.get(started.id)).status).toBe('stopped')
  })

  it('redacts secret- and path-like task history at the storage boundary', async () => {
    const taskStore = await store()
    const agent = {
      chat: vi.fn(async () => ({ content: 'Finished at /Users/example/private/file.txt with api_key=secret-value', toolActivities: [], toolCallCount: 0 }))
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore, agent, createRouter: async () => router(), canUseTools: async () => false,
      confirm: vi.fn(async () => true)
    })
    const started = await controller.start(request({ input: 'Read /Users/example/private and use api_key=secret-value' }))
    const completed = await waitForTask(controller, started.id, 'completed')
    expect(JSON.stringify(completed)).not.toContain('/Users/example/private')
    expect(JSON.stringify(completed)).not.toContain('secret-value')
    expect(JSON.stringify(completed)).toContain('[REDACTED_PATH]')
  })

  it('uses a plan correction at runtime without persisting the private instruction', async () => {
    const taskStore = await store()
    const agent = {
      chat: vi.fn(async (_request, _tools, _execute, options) => {
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
        return { content: '', toolActivities: [], toolCallCount: 0 }
      })
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore, agent, createRouter: async () => router(), confirm: vi.fn(async () => true)
    })
    const started = await controller.start(request())
    await controller.modifyPlan(started.id, 'Only use the private family medical document named Example.')
    const persisted = JSON.stringify(await controller.get(started.id))
    expect(persisted).not.toContain('family medical')
    expect(persisted).not.toContain('Example')
    expect(persisted).toContain('private course correction')
    await controller.stop(started.id)
  })

  it('serializes concurrent starts before any asynchronous initialization can race', async () => {
    const taskStore = await store()
    let releaseRouter!: () => void
    const routerGate = new Promise<void>((resolve) => { releaseRouter = resolve })
    const agent = {
      chat: vi.fn(async (_request, _tools, _execute, options) => {
        await new Promise<void>((resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
        return { content: '', toolActivities: [], toolCallCount: 0 }
      })
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore,
      agent,
      createRouter: async () => { await routerGate; return router() },
      confirm: vi.fn(async () => true)
    })

    const first = controller.start(request())
    await expect(controller.start(request({ input: 'Second request' }))).rejects.toThrow(/finish or stop/i)
    releaseRouter()
    const started = await first
    await controller.stop(started.id)
    expect(await controller.list()).toHaveLength(1)
  })

  it('invalidates a pending approved action when the user pauses before approval resolves', async () => {
    const taskStore = await store()
    let releaseApproval!: (approved: boolean) => void
    let approvalReached!: () => void
    const reached = new Promise<void>((resolve) => { approvalReached = resolve })
    let sideEffects = 0
    const routed = router(vi.fn(async (toolRequest: ToolExecutionRequest, context: OmniToolRouteContext) => {
      const approved = await context.confirm({
        toolId: toolRequest.toolId,
        toolName: 'List workspace files',
        connectorId: 'workspace',
        action: 'write',
        category: 'write',
        risk: 'medium',
        approvalMode: context.approvalMode,
        summary: 'This changes data.',
        reason: 'Ask mode requires approval.',
        input: toolRequest.input
      }, context.signal)
      if (!approved) throw new Error('The stale action was cancelled.')
      sideEffects++
      return successful(toolRequest.toolId)
    }))
    const agent = {
      chat: vi.fn(async (_request, _tools, execute, options) => {
        await execute({ toolId: 'omni.update-plan', mode: 'omni', input: planInput() })
        try { await execute({ toolId: 'files.list', mode: 'omni', input: {} }) } catch { /* expected invalidation */ }
        await options.beforeAction?.()
        return { content: 'No stale action ran.', toolActivities: [], toolCallCount: 2 }
      })
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore,
      agent,
      createRouter: async () => routed,
      confirm: vi.fn(() => {
        approvalReached()
        return new Promise<boolean>((resolve) => { releaseApproval = resolve })
      })
    })

    const started = await controller.start(request())
    await reached
    await controller.pause(started.id)
    releaseApproval(true)
    await waitForTask(controller, started.id, 'paused')
    expect(sideEffects).toBe(0)
    await controller.stop(started.id)
  })

  it('pauses immediately for human cursor takeover and resumes the task-owned cursor session', async () => {
    const taskStore = await store()
    const resumeTask = vi.fn(async () => undefined)
    const agent = {
      chat: vi.fn(async (_request, _tools, _execute, options) => {
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) reject(options.signal.reason)
          else options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
        return { content: '', toolActivities: [], toolCallCount: 0 }
      })
    } as unknown as WorkAgentManager
    const controller = new OmniController({
      store: taskStore, agent, createRouter: async () => router(), confirm: vi.fn(async () => true), resumeTask
    })

    const started = await controller.start(request({ executionMode: 'cursor' }))
    const paused = await controller.pauseForUserTakeover(started.id)
    expect(paused.status).toBe('paused')
    expect(paused.events.at(-1)).toMatchObject({ kind: 'cursor', status: 'waiting', title: 'You took control' })
    const resumed = await controller.resume(started.id)
    expect(resumed.status).toBe('working')
    expect(resumeTask).toHaveBeenCalledWith(started.id)
    await controller.stop(started.id)
  })
})
