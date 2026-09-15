import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CodeAgentActivityManager, redactCodeAgentText } from './code-agent-activity-manager'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function manager(): Promise<{ value: CodeAgentActivityManager; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-code-agent-history-'))
  roots.push(root)
  const file = path.join(root, 'history.json')
  return { value: new CodeAgentActivityManager(file), file }
}

describe('CodeAgentActivityManager', () => {
  it('persists private bounded task metadata and updates timeline entries', async () => {
    const { value, file } = await manager()
    const task = await value.create({ title: 'Fix the tests', provider: 'google', model: 'gemini-test', approvalMode: 'ask', visibility: 'glasses', focusBehavior: 'automatic' })
    const event = await value.putEvent(task.id, { timestamp: task.createdAt, kind: 'test', status: 'running', title: 'Run tests', summary: 'npm test', command: 'npm test' })
    await value.putEvent(task.id, { id: event.id, timestamp: task.createdAt, completedAt: task.createdAt + 20, kind: 'test', status: 'succeeded', title: 'Run tests', summary: 'Tests passed', command: 'npm test', output: '4 passed' })
    await value.update(task.id, { status: 'completed', completedAt: task.createdAt + 30, resultSummary: 'Done' })

    const reopened = new CodeAgentActivityManager(file)
    expect(await reopened.list()).toMatchObject([{ id: task.id, status: 'completed', actionCount: 1 }])
    expect((await reopened.get(task.id)).events[0]).toMatchObject({ id: event.id, status: 'succeeded', output: '4 passed' })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('persists validated, redacted plan revisions without requiring them in legacy tasks', async () => {
    const { value, file } = await manager()
    const task = await value.create({
      title: 'Fix auth', provider: 'google', model: 'gemini-test', approvalMode: 'ask', visibility: 'standard', focusBehavior: 'automatic',
      plan: {
        revision: 0, updateType: 'initial', taskUnderstanding: 'Fix auth safely',
        reasoningSummary: 'Inspect the shared validator before editing callers.',
        steps: [{ id: 'inspect', title: 'Inspect auth', status: 'active' }, { id: 'test', title: 'Run tests', status: 'pending' }],
        completedSteps: 0, currentStep: 'Inspect auth', nextStep: 'Run tests', updatedBy: 'agent', updatedAt: 10
      }
    })
    await value.updatePlan(task.id, {
      ...task.plan!, revision: 1, updateType: 'changed', completedSteps: 1,
      steps: [{ ...task.plan!.steps[0], status: 'completed' }, { ...task.plan!.steps[1], status: 'active' }],
      currentStep: 'Run tests', nextStep: 'Report results',
      reasoningSummary: 'Authorization: Bearer plan-secret', changeReason: 'api_key=plan-secret', updatedAt: 20
    })

    const reopened = await new CodeAgentActivityManager(file).get(task.id)
    expect(reopened.plan).toMatchObject({ revision: 1, completedSteps: 1, currentStep: 'Run tests' })
    expect(JSON.stringify(reopened.plan)).not.toContain('plan-secret')
    const legacy = await value.create({ title: 'Legacy', provider: 'ollama', model: 'local', approvalMode: 'ask', visibility: 'standard', focusBehavior: 'automatic' })
    expect((await new CodeAgentActivityManager(file).get(legacy.id)).plan).toBeUndefined()
  })

  it('redacts credentials from commands, output, summaries, and stored JSON', async () => {
    const { value, file } = await manager()
    const task = await value.create({ title: 'Do safe work', provider: 'openai', model: 'model', approvalMode: 'auto', visibility: 'standard', focusBehavior: 'never' })
    await value.putEvent(task.id, {
      timestamp: 1, kind: 'terminal', status: 'failed', title: 'Command',
      summary: 'Authorization: Bearer top-secret-value',
      command: 'OPENAI_API_KEY=top-secret-value npm test',
      output: 'access_token=top-secret-value'
    })
    const stored = await fs.readFile(file, 'utf8')
    expect(stored).not.toContain('top-secret-value')
    expect(stored).toContain('••••')
    expect(redactCodeAgentText('PASSWORD=super-secret')).toBe('PASSWORD: ••••')
  })

  it('recovers safely from corrupt data and preserves active tasks when clearing history', async () => {
    const { value, file } = await manager()
    await fs.writeFile(file, '{bad json')
    expect(await value.list()).toEqual([])
    const active = await value.create({ title: 'Active', provider: 'ollama', model: 'local', approvalMode: 'full', visibility: 'standard', focusBehavior: 'when-needed' })
    const done = await value.create({ title: 'Done', provider: 'anthropic', model: 'cloud', approvalMode: 'ask', visibility: 'glasses', focusBehavior: 'automatic' })
    await value.update(done.id, { status: 'completed', completedAt: Date.now() })
    await value.clearHistory()
    expect((await value.list()).map((task) => task.id)).toEqual([active.id])
  })

  it('persists validated visibility and focus preferences', async () => {
    const { value, file } = await manager()
    expect(await value.getPreferences()).toEqual({ visibility: 'standard', focusBehavior: 'automatic' })
    await value.setPreferences('glasses', 'never')
    expect(await new CodeAgentActivityManager(file).getPreferences()).toEqual({ visibility: 'glasses', focusBehavior: 'never' })
    await expect(value.setPreferences('hidden' as 'standard', 'never')).rejects.toThrow(/valid/i)
  })
})
