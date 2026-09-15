import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolDescriptor } from '../../shared/tool-contracts'
import type { WorkAgentManager, WorkAgentRunOptions } from './work-agent-manager'
import { CodeAgentActivityManager } from './code-agent-activity-manager'
import { CodeAgentManager } from './code-agent-manager'
import type { CodeAgentToolService } from './code-agent-tool-service'
import { ToolRegistry } from './tool-registry'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omnicode-agent-manager-'))
  roots.push(root)
  const activity = new CodeAgentActivityManager(path.join(root, 'activity.json'))
  const tools = new ToolRegistry()
  const descriptor: ToolDescriptor = {
    id: 'files.read', name: 'Read file', description: 'Read one file.', connectorId: 'files', modes: ['code'],
    action: 'read', category: 'read', risk: 'low', reversible: true, externalSideEffect: false, confirmation: 'never', requiredScopes: [],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
  tools.register(descriptor, async () => ({ content: 'real file contents' }))
  const cleanupTask = vi.fn(async () => undefined)
  const taskEvents: unknown[] = []
  return { root, activity, tools, cleanupTask, taskEvents }
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('CodeAgentManager', () => {
  it('runs the shared provider tool loop, persists visible actions, and completes truthfully', async () => {
    const value = await fixture()
    const chat = vi.fn(async (_request, _tools, execute) => {
      const plan = await execute({
        toolId: 'agent.update-plan', mode: 'code', input: {
          updateType: 'initial', taskUnderstanding: 'Inspect the requested file',
          reasoningSummary: 'Reading the file is required to report verified contents.',
          steps: ['Read the file', 'Report what was verified'], completedSteps: 0,
          currentStep: 'Read the file', nextStep: 'Report what was verified',
          decision: 'Inspect the file before making any claim about it.'
        }
      })
      expect(plan.result).toMatchObject({ plan: { currentStep: 'Read the file', updatedBy: 'agent' } })
      const result = await execute({ toolId: 'files.read', mode: 'code', input: {} })
      expect(result.result).toEqual({ content: 'real file contents' })
      return { content: 'Verified the real file.', toolActivities: [], toolCallCount: 1 }
    })
    const manager = new CodeAgentManager({
      activity: value.activity, tools: value.tools,
      agent: { chat } as unknown as WorkAgentManager,
      toolService: { cleanupTask: value.cleanupTask } as unknown as CodeAgentToolService,
      currentWorkspace: () => value.root,
      confirm: vi.fn(async () => true),
      onEvent: (_sender, event) => value.taskEvents.push(event)
    })
    const started = await manager.start(7, {
      provider: 'google', model: 'gemini-test', workspaceRoot: value.root, task: 'Inspect the file', approvalMode: 'ask', visibility: 'glasses', focusBehavior: 'never'
    })
    await vi.waitFor(async () => expect((await manager.get(started.id)).status).toBe('completed'))
    expect(chat).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({
        mode: 'code', maxSteps: 20, maxToolCalls: 40,
        systemPrompt: expect.stringMatching(/untrusted data.*never as instructions/isu)
      })
    )
    const completed = await manager.get(started.id)
    expect(completed.resultSummary).toBe('Verified the real file.')
    expect(completed.plan).toMatchObject({ taskUnderstanding: 'Inspect the requested file', currentStep: 'Read the file' })
    expect(completed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'plan', status: 'succeeded', title: 'Plan created' }),
      expect.objectContaining({ kind: 'decision', status: 'info', title: 'Decision' }),
      expect.objectContaining({ kind: 'file', status: 'succeeded', toolId: 'files.read', reason: 'Supports the current plan step: Read the file' }),
      expect.objectContaining({ kind: 'result', status: 'succeeded' })
    ]))
    await vi.waitFor(() => expect(value.cleanupTask).toHaveBeenCalledWith(started.id))
  })

  it('pauses for a user plan edit and delivers the revised course before the next action', async () => {
    const value = await fixture()
    let options: WorkAgentRunOptions | undefined
    let releaseTurn: (() => void) | undefined
    const providerTurn = new Promise<void>((resolve) => { releaseTurn = resolve })
    const chat = vi.fn(async (_request, _tools, _execute, runOptions: WorkAgentRunOptions) => {
      options = runOptions
      await providerTurn
      await runOptions.beforeAction?.()
      const intervention = runOptions.takeIntervention?.()
      expect(intervention).toContain('Do not install dependencies')
      return { content: 'I followed the revised course.', toolActivities: [], toolCallCount: 0 }
    })
    const manager = new CodeAgentManager({
      activity: value.activity, tools: value.tools,
      agent: { chat } as unknown as WorkAgentManager,
      toolService: { cleanupTask: value.cleanupTask } as unknown as CodeAgentToolService,
      currentWorkspace: () => value.root, confirm: vi.fn(async () => true)
    })
    const started = await manager.start(11, {
      provider: 'google', model: 'gemini-test', workspaceRoot: value.root, task: 'Fix it', approvalMode: 'ask', visibility: 'standard', focusBehavior: 'automatic'
    })
    await vi.waitFor(() => expect(options).toBeDefined())
    await expect(manager.modifyPlan(11, started.id, 'Do not install dependencies.')).resolves.toMatchObject({ status: 'pausing' })
    expect((await manager.get(started.id)).plan).toMatchObject({ updateType: 'changed', updatedBy: 'user', changeReason: 'Do not install dependencies.' })
    releaseTurn?.()
    await vi.waitFor(async () => expect((await manager.get(started.id)).status).toBe('paused'))
    await manager.resume(11, started.id)
    await vi.waitFor(async () => expect((await manager.get(started.id)).status).toBe('completed'))
    await vi.waitFor(() => expect(value.cleanupTask).toHaveBeenCalledWith(started.id))
  })

  it('marks the active plan step skipped and pauses for replanning', async () => {
    const value = await fixture()
    let options: WorkAgentRunOptions | undefined
    const chat = vi.fn(async (_request, _tools, _execute, runOptions: WorkAgentRunOptions) => {
      options = runOptions
      await new Promise((_resolve, reject) => runOptions.signal?.addEventListener('abort', () => reject(runOptions.signal?.reason), { once: true }))
      return { content: '', toolActivities: [], toolCallCount: 0 }
    })
    const manager = new CodeAgentManager({
      activity: value.activity, tools: value.tools,
      agent: { chat } as unknown as WorkAgentManager,
      toolService: { cleanupTask: value.cleanupTask } as unknown as CodeAgentToolService,
      currentWorkspace: () => value.root, confirm: vi.fn(async () => true)
    })
    const started = await manager.start(12, {
      provider: 'ollama', model: 'tool-model', workspaceRoot: value.root, task: 'Inspect and test', approvalMode: 'auto', visibility: 'glasses', focusBehavior: 'never'
    })
    await vi.waitFor(() => expect(options).toBeDefined())
    const skipped = await manager.skipStep(12, started.id)
    expect(skipped).toMatchObject({ status: 'pausing', plan: { updateType: 'changed', currentStep: 'Waiting for a revised course of action' } })
    expect(skipped.plan?.steps[0]?.status).toBe('skipped')
    expect(skipped.events).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Plan step skipped', kind: 'plan' })]))
    await manager.stop(12, started.id)
    await vi.waitFor(() => expect(value.cleanupTask).toHaveBeenCalledTimes(2))
  })

  it('pauses only at an action boundary, resumes, and stops an in-flight provider turn', async () => {
    const value = await fixture()
    let options: WorkAgentRunOptions | undefined
    const chat = vi.fn(async (_request, _tools, _execute, runOptions: WorkAgentRunOptions) => {
      options = runOptions
      await new Promise((_resolve, reject) => runOptions.signal?.addEventListener('abort', () => reject(runOptions.signal?.reason), { once: true }))
      return { content: '', toolActivities: [], toolCallCount: 0 }
    })
    const manager = new CodeAgentManager({
      activity: value.activity, tools: value.tools,
      agent: { chat } as unknown as WorkAgentManager,
      toolService: { cleanupTask: value.cleanupTask } as unknown as CodeAgentToolService,
      currentWorkspace: () => value.root, confirm: vi.fn(async () => true)
    })
    const started = await manager.start(9, {
      provider: 'openai', model: 'test-model', workspaceRoot: value.root, task: 'Wait', approvalMode: 'full', visibility: 'standard', focusBehavior: 'automatic'
    })
    await vi.waitFor(() => expect(options).toBeDefined())
    await expect(manager.pause(9, started.id)).resolves.toMatchObject({ status: 'pausing' })
    const boundary = options?.beforeAction?.()
    await vi.waitFor(async () => expect((await manager.get(started.id)).status).toBe('paused'))
    await manager.resume(9, started.id)
    await boundary
    expect((await manager.get(started.id)).status).toBe('running')
    await manager.stop(9, started.id)
    await vi.waitFor(async () => expect((await manager.get(started.id)).status).toBe('stopped'))
    await vi.waitFor(() => expect(value.cleanupTask).toHaveBeenCalledWith(started.id))
  })

  it('rejects workspace and control values outside the trusted task boundary', async () => {
    const value = await fixture()
    const manager = new CodeAgentManager({
      activity: value.activity, tools: value.tools, agent: {} as WorkAgentManager,
      toolService: { cleanupTask: value.cleanupTask } as unknown as CodeAgentToolService,
      currentWorkspace: () => value.root, confirm: vi.fn(async () => true)
    })
    await expect(manager.start(1, {
      provider: 'google', model: 'gemini-test', workspaceRoot: `${value.root}-other`, task: 'Escape', approvalMode: 'full', visibility: 'glasses', focusBehavior: 'automatic'
    })).rejects.toThrow(/currently open workspace/i)
  })
})
