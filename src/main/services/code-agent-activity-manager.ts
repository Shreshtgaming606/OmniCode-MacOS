import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  CodeAgentEvent,
  CodeAgentFocusBehavior,
  CodeAgentTask,
  CodeAgentTaskStatus,
  CodeAgentTaskSummary,
  CodeAgentVisibility
} from '../../shared/code-agent-contracts'
import { CODE_AGENT_LIMITS } from '../../shared/code-agent-contracts'
import type { AIProviderId } from '../../shared/contracts'
import { redactDiagnosticMessage } from './diagnostic-logger'

interface CodeAgentStore {
  version: 1
  preferences: { visibility: CodeAgentVisibility; focusBehavior: CodeAgentFocusBehavior }
  tasks: CodeAgentTask[]
}

const PROVIDERS = new Set<AIProviderId>(['ollama', 'openai', 'anthropic', 'google'])
const VISIBILITIES = new Set<CodeAgentVisibility>(['standard', 'glasses'])
const FOCUS_BEHAVIORS = new Set<CodeAgentFocusBehavior>(['automatic', 'when-needed', 'never'])
const TASK_STATUSES = new Set<CodeAgentTaskStatus>(['running', 'pausing', 'paused', 'completed', 'failed', 'stopped'])
const EVENT_KINDS = new Set(['task', 'terminal', 'file', 'git', 'browser', 'application', 'server', 'build', 'test', 'diagnostic', 'approval', 'result'])
const EVENT_STATUSES = new Set(['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'info'])
const CATEGORIES = new Set(['read', 'write', 'communication', 'destructive', 'external-submission', 'system', 'financial', 'account-security', 'sensitive-data'])
const RISKS = new Set(['low', 'medium', 'high', 'critical'])
const APPROVAL_MODES = new Set(['ask', 'auto', 'full'])

function defaults(): CodeAgentStore {
  return { version: 1, preferences: { visibility: 'standard', focusBehavior: 'automatic' }, tasks: [] }
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? redactCodeAgentText(value, maximum) : ''
}

export function redactCodeAgentText(value: unknown, maximum = CODE_AGENT_LIMITS.eventOutputCharacters): string {
  const source = typeof value === 'string' ? value : String(value ?? '')
  return redactDiagnosticMessage(source)
    .replace(/\b((?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|GITHUB|AWS|AZURE|NPM|PYPI|DATABASE|DB)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*[^\s]+/giu, '$1=••••')
    .replace(/\b(authorization|proxy-authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/giu, '$1: ••••')
    .replace(/([?&](?:key|api_key|access_token|refresh_token|token|client_secret)=)[^&#\s]+/giu, '$1••••')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .slice(0, maximum)
}

function safeEvent(value: CodeAgentEvent, taskId: string): CodeAgentEvent {
  if (!value || typeof value !== 'object' || value.taskId !== taskId || typeof value.id !== 'string') throw new Error('Code Agent activity is invalid.')
  if (!Number.isFinite(value.timestamp) || value.timestamp < 0 || (value.completedAt !== undefined && (!Number.isFinite(value.completedAt) || value.completedAt < value.timestamp))) {
    throw new Error('Code Agent activity has invalid timestamps.')
  }
  if (!EVENT_KINDS.has(value.kind) || !EVENT_STATUSES.has(value.status) || typeof value.title !== 'string' || typeof value.summary !== 'string') {
    throw new Error('Code Agent activity is invalid.')
  }
  if (value.category !== undefined && !CATEGORIES.has(value.category)) throw new Error('Code Agent activity category is invalid.')
  if (value.risk !== undefined && !RISKS.has(value.risk)) throw new Error('Code Agent activity risk is invalid.')
  if (value.approvalMode !== undefined && !APPROVAL_MODES.has(value.approvalMode)) throw new Error('Code Agent activity approval mode is invalid.')
  return {
    id: value.id.slice(0, 128), taskId,
    timestamp: value.timestamp,
    ...(value.completedAt !== undefined ? { completedAt: value.completedAt } : {}),
    kind: value.kind, status: value.status,
    title: safeText(value.title, 200),
    summary: safeText(value.summary, CODE_AGENT_LIMITS.eventSummaryCharacters),
    ...(value.toolId ? { toolId: safeText(value.toolId, 128) } : {}),
    ...(value.category ? { category: value.category } : {}),
    ...(value.risk ? { risk: value.risk } : {}),
    ...(value.approvalMode ? { approvalMode: value.approvalMode } : {}),
    ...(value.command ? { command: redactCodeAgentText(value.command, 4_000) } : {}),
    ...(value.output ? { output: redactCodeAgentText(value.output) } : {}),
    ...(value.relativePath ? { relativePath: safeText(value.relativePath, 1_024) } : {}),
    ...(value.url ? { url: safeText(value.url, 2_048) } : {}),
    ...(value.proposalId ? { proposalId: safeText(value.proposalId, 128) } : {})
  }
}

function safeTask(value: CodeAgentTask): CodeAgentTask {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.title !== 'string' || !PROVIDERS.has(value.provider)) {
    throw new Error('Code Agent task history is invalid.')
  }
  if (!VISIBILITIES.has(value.visibility) || !FOCUS_BEHAVIORS.has(value.focusBehavior) || !TASK_STATUSES.has(value.status)) {
    throw new Error('Code Agent task history is invalid.')
  }
  const approvalMode = APPROVAL_MODES.has(value.approvalMode) ? value.approvalMode : 'ask'
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || value.updatedAt < value.createdAt || (value.completedAt !== undefined && value.completedAt < value.createdAt)) {
    throw new Error('Code Agent task history has invalid timestamps.')
  }
  if (!Array.isArray(value.events) || value.events.length > CODE_AGENT_LIMITS.eventsPerTask) throw new Error('Code Agent task history is too large.')
  const events = value.events.map((event) => safeEvent(event, value.id))
  return {
    id: value.id.slice(0, 128),
    title: safeText(value.title, CODE_AGENT_LIMITS.titleCharacters) || 'Code Agent task',
    provider: value.provider,
    model: safeText(value.model, 256),
    approvalMode,
    visibility: value.visibility,
    focusBehavior: value.focusBehavior,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.completedAt !== undefined ? { completedAt: value.completedAt } : {}),
    actionCount: events.length,
    ...(value.resultSummary ? { resultSummary: safeText(value.resultSummary, CODE_AGENT_LIMITS.resultCharacters) } : {}),
    ...(value.error ? { error: safeText(value.error, 2_000) } : {}),
    events
  }
}

function safeStore(value: unknown): CodeAgentStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Code Agent history is invalid.')
  const record = value as Partial<CodeAgentStore>
  if (record.version !== 1 || !record.preferences || !Array.isArray(record.tasks) || record.tasks.length > CODE_AGENT_LIMITS.tasks) {
    throw new Error('Code Agent history is invalid.')
  }
  if (!VISIBILITIES.has(record.preferences.visibility) || !FOCUS_BEHAVIORS.has(record.preferences.focusBehavior)) {
    throw new Error('Code Agent preferences are invalid.')
  }
  return { version: 1, preferences: { ...record.preferences }, tasks: record.tasks.map(safeTask) }
}

function summary(task: CodeAgentTask): CodeAgentTaskSummary {
  const { events: _events, ...result } = task
  return { ...result, actionCount: task.events.length }
}

export class CodeAgentActivityManager {
  #operation: Promise<void> = Promise.resolve()

  constructor(private readonly storePath: string) {}

  async create(input: { title: string; provider: AIProviderId; model: string; approvalMode: CodeAgentTask['approvalMode']; visibility: CodeAgentVisibility; focusBehavior: CodeAgentFocusBehavior }): Promise<CodeAgentTask> {
    const now = Date.now()
    const created = safeTask({
      id: randomUUID(), title: input.title, provider: input.provider, model: input.model, approvalMode: input.approvalMode,
      visibility: input.visibility, focusBehavior: input.focusBehavior,
      status: 'running', createdAt: now, updatedAt: now, actionCount: 0, events: []
    })
    await this.#mutate((store) => { store.tasks = [created, ...store.tasks].slice(0, CODE_AGENT_LIMITS.tasks) })
    return structuredClone(created)
  }

  async list(): Promise<CodeAgentTaskSummary[]> {
    await this.#operation
    return (await this.#read()).tasks.map((task) => summary(task))
  }

  async get(id: string): Promise<CodeAgentTask> {
    await this.#operation
    const task = (await this.#read()).tasks.find((candidate) => candidate.id === id)
    if (!task) throw new Error('That Code Agent task was not found.')
    return structuredClone(task)
  }

  async update(id: string, changes: Partial<Pick<CodeAgentTask, 'status' | 'resultSummary' | 'error' | 'completedAt'>>): Promise<CodeAgentTask> {
    let result: CodeAgentTask | undefined
    await this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === id)
      if (!task) throw new Error('That Code Agent task was not found.')
      result = safeTask({ ...task, ...changes, updatedAt: Date.now() })
      store.tasks[store.tasks.indexOf(task)] = result
    })
    return structuredClone(result as CodeAgentTask)
  }

  async putEvent(taskId: string, value: Omit<CodeAgentEvent, 'id' | 'taskId'> & { id?: string }): Promise<CodeAgentEvent> {
    const event = safeEvent({ ...value, id: value.id ?? randomUUID(), taskId }, taskId)
    await this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === taskId)
      if (!task) throw new Error('That Code Agent task was not found.')
      const existing = task.events.findIndex((candidate) => candidate.id === event.id)
      if (existing >= 0) task.events[existing] = event
      else task.events.push(event)
      task.events = task.events.slice(-CODE_AGENT_LIMITS.eventsPerTask)
      task.actionCount = task.events.length
      task.updatedAt = Date.now()
    })
    return structuredClone(event)
  }

  async clearHistory(): Promise<void> {
    await this.#mutate((store) => { store.tasks = store.tasks.filter((task) => ['running', 'pausing', 'paused'].includes(task.status)) })
  }

  async getPreferences(): Promise<CodeAgentStore['preferences']> {
    await this.#operation
    return { ...(await this.#read()).preferences }
  }

  async setPreferences(visibility: CodeAgentVisibility, focusBehavior: CodeAgentFocusBehavior): Promise<CodeAgentStore['preferences']> {
    if (!VISIBILITIES.has(visibility) || !FOCUS_BEHAVIORS.has(focusBehavior)) throw new Error('Choose valid Code Agent visibility and focus settings.')
    await this.#mutate((store) => { store.preferences = { visibility, focusBehavior } })
    return { visibility, focusBehavior }
  }

  async #mutate(change: (store: CodeAgentStore) => void): Promise<void> {
    const task = this.#operation.then(async () => {
      const store = await this.#read()
      change(store)
      await this.#write(safeStore(store))
    })
    this.#operation = task.catch(() => undefined)
    await task
  }

  async #read(): Promise<CodeAgentStore> {
    try {
      const stat = await fs.stat(this.storePath)
      if (stat.size > CODE_AGENT_LIMITS.storeBytes) return defaults()
      return safeStore(JSON.parse(await fs.readFile(this.storePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError || (error instanceof Error && /Code Agent/u.test(error.message))) return defaults()
      throw error
    }
  }

  async #write(store: CodeAgentStore): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(store)}\n`, { mode: 0o600 })
      await fs.rename(temporaryPath, this.storePath)
      await fs.chmod(this.storePath, 0o600)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}
