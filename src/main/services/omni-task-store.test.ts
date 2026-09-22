import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OMNI_LIMITS, type OmniPlan, type OmniTask } from '../../shared/omni-contracts'
import { OmniTaskStore, redactOmniActivityText } from './omni-task-store'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function store(): Promise<{ value: OmniTaskStore; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-omni-tasks-'))
  roots.push(root)
  const file = path.join(root, 'private', 'tasks.json')
  return { value: new OmniTaskStore(file), file }
}

function plan(overrides: Partial<OmniPlan> = {}): OmniPlan {
  return {
    revision: 0,
    updateType: 'initial',
    taskUnderstanding: 'Safely complete the requested task.',
    reasoningSummary: 'Inspect the state, perform the bounded action, and verify the result.',
    steps: [
      { id: 'inspect', title: 'Inspect current state', status: 'active' },
      { id: 'execute', title: 'Perform the action', status: 'pending' }
    ],
    completedSteps: 0,
    currentStep: 'Inspect current state',
    nextStep: 'Perform the action',
    updatedBy: 'agent',
    updatedAt: 1,
    ...overrides
  }
}

async function createTask(value: OmniTaskStore, title = 'Bounded Omni task') {
  return value.create({
    title,
    provider: 'ollama',
    model: 'local-test',
    approvalMode: 'ask',
    executionMode: 'invisible',
    activationSource: 'main-window',
    plan: plan()
  })
}

describe('OmniTaskStore persistence and concurrency', () => {
  it('starts empty, atomically persists private task metadata, and returns defensive copies', async () => {
    const { value, file } = await store()
    expect(await value.list()).toEqual([])

    const task = await createTask(value)
    task.title = 'mutated outside store'
    task.plan!.steps[0].title = 'mutated plan'

    const reopened = new OmniTaskStore(file)
    expect(await reopened.list()).toMatchObject([{ id: task.id, title: 'Bounded Omni task', actionCount: 0, status: 'planning' }])
    const loaded = await reopened.get(task.id)
    expect(loaded.title).toBe('Bounded Omni task')
    expect(loaded.plan?.steps[0].title).toBe('Inspect current state')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(path.dirname(file))).toEqual(['tasks.json'])
  })

  it('serializes concurrent event writes without losing updates or leaving temporary files', async () => {
    const { value, file } = await store()
    const task = await createTask(value)
    const count = 80

    await Promise.all(Array.from({ length: count }, (_, index) => value.putEvent(task.id, {
      id: `event-${index}`,
      timestamp: index + 1,
      kind: 'tool',
      status: 'succeeded',
      title: `Action ${index}`,
      summary: `Action ${index} completed.`
    })))

    const loaded = await value.get(task.id)
    expect(loaded.events).toHaveLength(count)
    expect(new Set(loaded.events.map((event) => event.id)).size).toBe(count)
    expect(loaded.actionCount).toBe(count)
    expect(await fs.readdir(path.dirname(file))).toEqual(['tasks.json'])
  })

  it('retains only the newest bounded number of tasks and events', async () => {
    const { value, file } = await store()
    await createTask(value, 'Seed')
    const seeded = JSON.parse(await fs.readFile(file, 'utf8')) as { version: 1; tasks: OmniTask[] }
    const base = seeded.tasks[0]
    seeded.tasks = Array.from({ length: OMNI_LIMITS.tasks }, (_, index) => ({
      ...base,
      id: `seed-${index}`,
      title: `Task ${index}`,
      events: [],
      actionCount: 0
    }))
    await fs.writeFile(file, `${JSON.stringify(seeded)}\n`, { mode: 0o600 })

    const newest = await createTask(value, 'Newest task')
    const listed = await value.list()
    expect(listed).toHaveLength(OMNI_LIMITS.tasks)
    expect(listed[0].id).toBe(newest.id)
    expect(listed.some((task) => task.id === 'seed-99')).toBe(false)

    const eventSeed = JSON.parse(await fs.readFile(file, 'utf8')) as { version: 1; tasks: OmniTask[] }
    const newestRecord = eventSeed.tasks.find((task) => task.id === newest.id)!
    newestRecord.events = Array.from({ length: OMNI_LIMITS.eventsPerTask }, (_, index) => ({
      id: `bounded-${index}`,
      taskId: newest.id,
      timestamp: index + 1,
      kind: 'task' as const,
      status: 'info' as const,
      title: 'Bounded event',
      summary: `Event ${index}`
    }))
    newestRecord.actionCount = newestRecord.events.length
    await fs.writeFile(file, `${JSON.stringify(eventSeed)}\n`, { mode: 0o600 })

    for (let index = OMNI_LIMITS.eventsPerTask; index < OMNI_LIMITS.eventsPerTask + 3; index += 1) {
      await value.putEvent(newest.id, {
        id: `bounded-${index}`,
        timestamp: index + 1,
        kind: 'task',
        status: 'info',
        title: 'Bounded event',
        summary: `Event ${index}`
      })
    }
    const loaded = await value.get(newest.id)
    expect(loaded.events).toHaveLength(OMNI_LIMITS.eventsPerTask)
    expect(loaded.events[0].id).toBe('bounded-3')
    expect(loaded.events.at(-1)?.id).toBe(`bounded-${OMNI_LIMITS.eventsPerTask + 2}`)
  })

  it('keeps the persistence queue usable after a rejected mutation', async () => {
    const { value } = await store()
    const task = await createTask(value)
    await expect(value.putEvent(task.id, {
      id: '../unsafe', timestamp: 1, kind: 'task', status: 'info', title: 'Bad', summary: 'Bad'
    })).rejects.toThrow(/activity ID/i)

    await expect(value.putEvent(task.id, {
      id: 'safe-event', timestamp: 2, kind: 'task', status: 'info', title: 'Safe', summary: 'Safe'
    })).resolves.toMatchObject({ id: 'safe-event' })
  })
})

describe('OmniTaskStore validation, retention, and failure states', () => {
  it('validates plans, task changes, events, timestamps, IDs, and enum values', async () => {
    const { value } = await store()
    await expect(value.create({
      title: 'Bad', provider: 'invalid' as 'ollama', model: 'model', approvalMode: 'ask',
      executionMode: 'invisible', activationSource: 'main-window'
    })).rejects.toThrow(/history/i)

    await expect(value.create({
      title: 'Bad plan', provider: 'ollama', model: 'model', approvalMode: 'ask',
      executionMode: 'invisible', activationSource: 'main-window',
      plan: plan({ steps: [
        { id: 'same', title: 'One', status: 'completed' },
        { id: 'same', title: 'Two', status: 'active' }
      ], completedSteps: 1 })
    })).rejects.toThrow(/plan/i)

    const task = await createTask(value)
    await expect(value.update(task.id, { status: 'unknown' as 'working' })).rejects.toThrow(/history/i)
    await expect(value.update(task.id, { completedAt: task.createdAt - 1 })).rejects.toThrow(/timestamps/i)
    await expect(value.putEvent(task.id, {
      timestamp: 1.5, kind: 'tool', status: 'info', title: 'Invalid time', summary: 'Invalid'
    })).rejects.toThrow(/timestamps/i)
    await expect(value.putEvent(task.id, {
      timestamp: 1, kind: 'tool', status: 'info', title: 'Invalid category', summary: 'Invalid',
      category: 'unknown' as 'read'
    })).rejects.toThrow(/category/i)
    await expect(value.updatePlan(task.id, plan({
      revision: 1,
      updateType: 'changed',
      changeReason: undefined
    }))).rejects.toThrow(/plan/i)
    await expect(value.updatePlan(task.id, plan({
      steps: Array.from({ length: OMNI_LIMITS.planSteps + 1 }, (_, index) => ({
        id: `step-${index}`, title: `Step ${index}`, status: 'pending' as const
      }))
    }))).rejects.toThrow(/plan/i)
  })

  it('truncates bounded display metadata before persistence', async () => {
    const { value } = await store()
    const task = await createTask(value, 'T'.repeat(OMNI_LIMITS.titleCharacters + 25))
    const event = await value.putEvent(task.id, {
      timestamp: 1,
      kind: 'result',
      status: 'succeeded',
      title: 'E'.repeat(OMNI_LIMITS.eventTitleCharacters + 25),
      summary: 'S'.repeat(OMNI_LIMITS.eventSummaryCharacters + 25),
      output: 'O'.repeat(OMNI_LIMITS.eventOutputCharacters + 25)
    })
    const loaded = await value.get(task.id)

    expect(loaded.title).toHaveLength(OMNI_LIMITS.titleCharacters)
    expect(event.title).toHaveLength(OMNI_LIMITS.eventTitleCharacters)
    expect(event.summary).toHaveLength(OMNI_LIMITS.eventSummaryCharacters)
    expect(event.output).toHaveLength(OMNI_LIMITS.eventOutputCharacters)
  })

  it('fails closed to empty history for corrupt, malformed, oversized, and non-file stores', async () => {
    const { value, file } = await store()
    await fs.mkdir(path.dirname(file), { recursive: true })

    await fs.writeFile(file, '{broken')
    await expect(value.list()).resolves.toEqual([])

    await fs.writeFile(file, JSON.stringify({ version: 1, tasks: [{ id: 'malformed' }] }))
    await expect(value.list()).resolves.toEqual([])

    await fs.writeFile(file, 'x'.repeat(OMNI_LIMITS.taskStoreBytes + 1))
    await expect(value.list()).resolves.toEqual([])

    await fs.rm(file)
    await fs.mkdir(file)
    await expect(value.list()).resolves.toEqual([])
  })

  it('prunes only expired terminal tasks, preserves active tasks, and clears terminal history explicitly', async () => {
    const { value } = await store()
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const expired = await createTask(value, 'Expired')
    const active = await createTask(value, 'Active')
    await value.update(expired.id, { status: 'completed', completedAt: 1_100 })

    vi.mocked(Date.now).mockReturnValue(3 * 24 * 60 * 60 * 1_000)
    const recent = await createTask(value, 'Recent')
    await value.update(recent.id, { status: 'failed', completedAt: Date.now() })

    await expect(value.pruneExpired(1, Date.now())).resolves.toBe(1)
    expect((await value.list()).map((task) => task.id)).toEqual([recent.id, active.id])
    await expect(value.pruneExpired(-1)).rejects.toThrow(/retention/i)
    await expect(value.pruneExpired(OMNI_LIMITS.activityRetentionDays + 1)).rejects.toThrow(/retention/i)
    await expect(value.pruneExpired(1, 1.5)).rejects.toThrow(/retention/i)

    await value.clearHistory()
    expect((await value.list()).map((task) => task.id)).toEqual([active.id])
  })

  it('marks nonterminal records stopped after an interrupted application lifecycle', async () => {
    const { value } = await store()
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const working = await createTask(value, 'Working')
    const paused = await createTask(value, 'Paused')
    const completed = await createTask(value, 'Completed')
    await value.update(working.id, { status: 'working' })
    await value.update(paused.id, { status: 'paused' })
    await value.update(completed.id, { status: 'completed', completedAt: 1_100 })

    await expect(value.recoverInterrupted(2_000)).resolves.toBe(2)
    expect(await value.get(working.id)).toMatchObject({ status: 'stopped', completedAt: 2_000, resultSummary: expect.stringContaining('previously closed') })
    expect(await value.get(paused.id)).toMatchObject({ status: 'stopped', completedAt: 2_000 })
    expect(await value.get(completed.id)).toMatchObject({ status: 'completed', completedAt: 1_100 })
    await expect(value.recoverInterrupted(1.5)).rejects.toThrow(/recovery time/i)
  })
})

describe('Omni activity privacy boundary', () => {
  it('redacts prompts, credentials, URLs, and macOS/Unix/Windows paths while enforcing output bounds', () => {
    const sensitive = [
      'prompt: summarize private board notes',
      'transcript="call the private contact"',
      'Authorization: Bearer bearer-secret-value',
      'OPENAI_API_KEY=environment-secret-value',
      'apiKey: "json-secret-value"',
      'sk-proj-abcdefghijklmno',
      'AQ.abcdefghijklmnopqrstuvwxyz123456',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJabcdefghijk.abcdefghijk.abcdefghijk',
      'https://example.test/private?token=query-secret',
      'file:///Users/alice/Private/file.txt',
      '"/Users/alice/Project With Spaces/private.txt"',
      '/Volumes/Private Disk/project/file.ts',
      '~/Documents/private.txt',
      'C:\\Users\\Alice\\private.txt',
      '\\\\server\\share\\private.txt',
      'src/private/file.ts'
    ].join('\n')

    const redacted = redactOmniActivityText(sensitive, 20_000)
    for (const forbidden of [
      'private board notes', 'private contact', 'bearer-secret-value', 'environment-secret-value',
      'json-secret-value', 'abcdefghijklmno', 'abcdefghijklmnopqrstuvwxyz123456', 'AKIAABCDEFGHIJKLMNOP', 'eyJabcdefghijk',
      'example.test', '/Users/alice', '/Volumes/Private', '~/Documents', 'C:\\Users', 'server\\share', 'src/private'
    ]) {
      expect(redacted).not.toContain(forbidden)
    }
    expect(redacted).toMatch(/REDACTED|••••/u)
    expect(redactOmniActivityText('x'.repeat(100_000), 64)).toHaveLength(64)
    expect(redactOmniActivityText('ok\u0000hidden', 100)).toBe('ok hidden')
  })

  it('persists only whitelisted, redacted metadata and never raw request, transcript, path, or secret fields', async () => {
    const { value, file } = await store()
    const task = await value.create({
      title: 'Safe task title', provider: 'google', model: 'gemini-test', approvalMode: 'ask',
      executionMode: 'cursor', activationSource: 'global-shortcut', plan: plan(),
      input: 'raw-prompt-sentinel', transcript: 'raw-transcript-sentinel',
      absolutePath: '/Users/alice/Secret Project/file.ts', apiKey: 'raw-api-secret-sentinel'
    } as Parameters<OmniTaskStore['create']>[0] & Record<string, unknown>)

    await value.putEvent(task.id, {
      timestamp: 2,
      kind: 'tool',
      status: 'succeeded',
      title: 'Read a file',
      summary: 'prompt: raw-summary-prompt-sentinel',
      reason: 'Used "/Users/alice/Secret Project/file.ts"',
      output: 'Authorization: Bearer raw-output-secret-sentinel',
      input: 'raw-event-input-sentinel',
      transcript: 'raw-event-transcript-sentinel'
    } as Parameters<OmniTaskStore['putEvent']>[1] & Record<string, unknown>)

    await value.update(task.id, {
      status: 'completed',
      completedAt: Date.now(),
      resultSummary: 'Saved /Users/alice/Secret Project/file.ts; password=raw-result-secret-sentinel'
    })

    const raw = await fs.readFile(file, 'utf8')
    for (const forbidden of [
      'raw-prompt-sentinel', 'raw-transcript-sentinel', 'raw-api-secret-sentinel',
      'raw-summary-prompt-sentinel', 'raw-event-input-sentinel', 'raw-event-transcript-sentinel',
      'raw-output-secret-sentinel', 'raw-result-secret-sentinel', '/Users/alice/Secret Project/file.ts'
    ]) {
      expect(raw).not.toContain(forbidden)
    }
    const persisted = JSON.parse(raw) as { tasks: Array<Record<string, unknown>> }
    expect(persisted.tasks[0]).not.toHaveProperty('input')
    expect(persisted.tasks[0]).not.toHaveProperty('transcript')
    expect(persisted.tasks[0]).not.toHaveProperty('absolutePath')
    expect(persisted.tasks[0]).not.toHaveProperty('apiKey')
    expect((persisted.tasks[0].events as Array<Record<string, unknown>>)[0]).not.toHaveProperty('input')
    expect((persisted.tasks[0].events as Array<Record<string, unknown>>)[0]).not.toHaveProperty('transcript')
  })

  it('does not expose the event list through summaries', async () => {
    const { value } = await store()
    const task = await createTask(value)
    await value.putEvent(task.id, {
      timestamp: 1, kind: 'task', status: 'info', title: 'Metadata', summary: 'Safe summary'
    })
    const summary = (await value.list())[0]
    expect(summary).not.toHaveProperty('events')
    expect(summary.actionCount).toBe(1)
  })
})
