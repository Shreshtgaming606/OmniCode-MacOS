import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  OmniActivationSource,
  OmniEvent,
  OmniExecutionMode,
  OmniPlan,
  OmniStatus,
  OmniTask,
  OmniTaskSummary
} from '../../shared/omni-contracts'
import { OMNI_LIMITS } from '../../shared/omni-contracts'
import type { AIProviderId } from '../../shared/contracts'
import type { WorkApprovalMode } from '../../shared/tool-contracts'

interface OmniTaskStoreFile {
  version: 1
  tasks: OmniTask[]
}

const PROVIDERS = new Set<AIProviderId>(['ollama', 'openai', 'anthropic', 'google'])
const APPROVAL_MODES = new Set<WorkApprovalMode>(['ask', 'auto', 'full'])
const EXECUTION_MODES = new Set<OmniExecutionMode>(['invisible', 'cursor'])
const ACTIVATION_SOURCES = new Set<OmniActivationSource>(['main-window', 'overlay', 'global-shortcut', 'wake-word', 'menu-bar'])
const TASK_STATUSES = new Set<OmniStatus>([
  'idle', 'listening', 'transcribing', 'planning', 'waiting-for-approval', 'working', 'using-cursor',
  'speaking', 'paused', 'completed', 'failed', 'stopped'
])
const TERMINAL_STATUSES = new Set<OmniStatus>(['completed', 'failed', 'stopped'])
const EVENT_KINDS = new Set([
  'activation', 'voice', 'task', 'plan', 'decision', 'tool', 'approval', 'terminal', 'file', 'git',
  'browser', 'application', 'cursor', 'result', 'error'
])
const EVENT_STATUSES = new Set(['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'info'])
const CATEGORIES = new Set(['read', 'write', 'communication', 'destructive', 'external-submission', 'system', 'financial', 'account-security', 'sensitive-data'])
const RISKS = new Set(['low', 'medium', 'high', 'critical'])
const PLAN_UPDATE_TYPES = new Set(['initial', 'progress', 'changed'])
const PLAN_STEP_STATUSES = new Set(['pending', 'active', 'completed', 'skipped'])
const PLAN_UPDATED_BY = new Set(['system', 'agent', 'user'])
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u

function defaults(): OmniTaskStoreFile {
  return { version: 1, tasks: [] }
}

/**
 * Redacts persisted activity at the storage boundary. Omni history is useful
 * operational metadata, not a transcript: URLs and filesystem paths are also
 * removed so it cannot become a quiet record of private locations.
 */
export function redactOmniActivityText(value: unknown, maximum = OMNI_LIMITS.eventOutputCharacters): string {
  const source = typeof value === 'string' ? value : String(value ?? '')
  const boundedMaximum = Number.isSafeInteger(maximum) && maximum >= 0 ? maximum : OMNI_LIMITS.eventOutputCharacters
  // Only inspect a bounded prefix. Every persisted field is truncated, so
  // processing an attacker-controlled multi-megabyte string buys us nothing
  // and can otherwise turn redaction into a memory/CPU denial of service.
  const inspectionLimit = Math.max(boundedMaximum * 4, boundedMaximum + 4_096)
  return source.slice(0, inspectionLimit)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu, '••••')
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, '[REDACTED_URL]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'<>]+/giu, '[REDACTED_URL]')
    .replace(/\bfile:\/\/\/[^\r\n"'<>;,]+/giu, '[REDACTED_PATH]')
    .replace(/(["'])((?:\/(?!\/)|~\/|[A-Z]:\\|\\\\)[^"'\r\n]+)\1/giu, '$1[REDACTED_PATH]$1')
    .replace(/\b(prompt|transcript|user[_ -]?input|raw[_ -]?input)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/giu, '$1: [REDACTED]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{8,}|AIza[a-z0-9_-]{10,}|github_pat_[a-z0-9_]{10,}|gh[pousr]_[a-z0-9_]{10,}|xox[baprs]-[a-z0-9-]{10,})\b/giu, '••••')
    .replace(/\b(?:AQ\.|ya29\.)[a-z0-9_-]{20,}\b/giu, '••••')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, '••••')
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/gu, '••••')
    .replace(/\b((?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|GITHUB|AWS|AZURE|NPM|PYPI|DATABASE|DB)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*[^\s]+/giu, '$1=••••')
    .replace(/\b(authorization|proxy-authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*(?:Bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/giu, '$1: ••••')
    .replace(/([?&](?:key|api_key|access_token|refresh_token|token|client_secret)=)[^&#\s]+/giu, '$1••••')
    .replace(/(^|[\s("'=])~\/(?:[^\s"'<>;,]+(?:\s+[^\s"'<>;,]+)*)/gmu, '$1[REDACTED_PATH]')
    .replace(/(^|[\s("'=])\/(?:Users|Volumes|private|tmp|var|etc|opt|usr|Applications|Library|System|home)(?:\/[^\r\n"'<>;,]*)?/gmu, '$1[REDACTED_PATH]')
    .replace(/(^|[\s("'=])\/(?!\/)[^\s"'<>;,]*(?:\/[^\s"'<>;,]*)*/gmu, '$1[REDACTED_PATH]')
    .replace(/\b[A-Z]:\\[^\r\n"'<>;,]+/giu, '[REDACTED_PATH]')
    .replace(/\\\\[^\s\\/]+\\[^\r\n"'<>;,]+/gu, '[REDACTED_PATH]')
    .replace(/(^|[\s("'=])(?:\.\.?\/|[a-zA-Z0-9_.-]+\/)[a-zA-Z0-9_.@%+~/-]+/gmu, '$1[REDACTED_PATH]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .slice(0, boundedMaximum)
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? redactOmniActivityText(value, maximum) : ''
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Omni ${label} is invalid.`)
  return value
}

function safePlan(value: OmniPlan): OmniPlan {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !PLAN_UPDATE_TYPES.has(value.updateType) || !PLAN_UPDATED_BY.has(value.updatedBy) ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || !Array.isArray(value.steps) ||
      value.steps.length < 1 || value.steps.length > OMNI_LIMITS.planSteps ||
      !Number.isSafeInteger(value.completedSteps) || value.completedSteps < 0 || value.completedSteps > value.steps.length ||
      typeof value.taskUnderstanding !== 'string' || !value.taskUnderstanding.trim() ||
      typeof value.reasoningSummary !== 'string' || !value.reasoningSummary.trim() ||
      typeof value.currentStep !== 'string' || !value.currentStep.trim() ||
      typeof value.nextStep !== 'string' || !value.nextStep.trim() ||
      (value.decision !== undefined && typeof value.decision !== 'string') ||
      (value.changeReason !== undefined && typeof value.changeReason !== 'string') ||
      (value.updateType === 'changed' && (typeof value.changeReason !== 'string' || !value.changeReason.trim())) ||
      (value.assumptions !== undefined && (!Array.isArray(value.assumptions) || value.assumptions.length > OMNI_LIMITS.planAssumptions ||
        value.assumptions.some((item) => typeof item !== 'string' || !item.trim())))) {
    throw new Error('Omni plan is invalid.')
  }
  const steps = value.steps.map((step) => {
    if (!step || typeof step !== 'object' || typeof step.title !== 'string' || !PLAN_STEP_STATUSES.has(step.status)) {
      throw new Error('Omni plan step is invalid.')
    }
    const id = safeId(step.id, 'plan step ID')
    const title = safeText(step.title, OMNI_LIMITS.planStepCharacters)
    if (!title.trim()) throw new Error('Omni plan step is invalid.')
    return { id, title, status: step.status }
  })
  if (new Set(steps.map((step) => step.id)).size !== steps.length ||
      steps.filter((step) => step.status === 'completed').length !== value.completedSteps) {
    throw new Error('Omni plan progress is invalid.')
  }
  const taskUnderstanding = safeText(value.taskUnderstanding, OMNI_LIMITS.planUnderstandingCharacters)
  const reasoningSummary = safeText(value.reasoningSummary, OMNI_LIMITS.reasoningSummaryCharacters)
  const currentStep = safeText(value.currentStep, OMNI_LIMITS.planStepCharacters)
  const nextStep = safeText(value.nextStep, OMNI_LIMITS.planStepCharacters)
  if (!taskUnderstanding.trim() || !reasoningSummary.trim() || !currentStep.trim() || !nextStep.trim()) {
    throw new Error('Omni plan is invalid.')
  }
  return {
    revision: value.revision,
    updateType: value.updateType,
    taskUnderstanding,
    reasoningSummary,
    steps,
    completedSteps: value.completedSteps,
    currentStep,
    nextStep,
    ...(value.decision ? { decision: safeText(value.decision, OMNI_LIMITS.planDecisionCharacters) } : {}),
    ...(value.assumptions?.length ? {
      assumptions: value.assumptions.map((item) => safeText(item, OMNI_LIMITS.planDecisionCharacters))
    } : {}),
    ...(value.changeReason ? { changeReason: safeText(value.changeReason, OMNI_LIMITS.planDecisionCharacters) } : {}),
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt
  }
}

function safeEvent(value: OmniEvent, taskId: string): OmniEvent {
  if (!value || typeof value !== 'object' || value.taskId !== taskId) throw new Error('Omni activity is invalid.')
  const id = safeId(value.id, 'activity ID')
  if (!Number.isSafeInteger(value.timestamp) || value.timestamp < 0 ||
      (value.completedAt !== undefined && (!Number.isSafeInteger(value.completedAt) || value.completedAt < value.timestamp))) {
    throw new Error('Omni activity has invalid timestamps.')
  }
  if (!EVENT_KINDS.has(value.kind) || !EVENT_STATUSES.has(value.status) || typeof value.title !== 'string' || typeof value.summary !== 'string') {
    throw new Error('Omni activity is invalid.')
  }
  if (value.category !== undefined && !CATEGORIES.has(value.category)) throw new Error('Omni activity category is invalid.')
  if (value.risk !== undefined && !RISKS.has(value.risk)) throw new Error('Omni activity risk is invalid.')
  if (value.approvalMode !== undefined && !APPROVAL_MODES.has(value.approvalMode)) throw new Error('Omni activity approval mode is invalid.')
  if (value.executionMode !== undefined && !EXECUTION_MODES.has(value.executionMode)) throw new Error('Omni activity execution mode is invalid.')
  if ((value.reason !== undefined && typeof value.reason !== 'string') ||
      (value.output !== undefined && typeof value.output !== 'string')) {
    throw new Error('Omni activity is invalid.')
  }
  const title = safeText(value.title, OMNI_LIMITS.eventTitleCharacters)
  const summary = safeText(value.summary, OMNI_LIMITS.eventSummaryCharacters)
  if (!title.trim() || !summary.trim()) throw new Error('Omni activity is invalid.')
  return {
    id,
    taskId,
    timestamp: value.timestamp,
    ...(value.completedAt !== undefined ? { completedAt: value.completedAt } : {}),
    kind: value.kind,
    status: value.status,
    title,
    summary,
    ...(value.toolId ? { toolId: safeId(value.toolId, 'tool ID') } : {}),
    ...(value.connectorId ? { connectorId: safeId(value.connectorId, 'connector ID') } : {}),
    ...(value.category ? { category: value.category } : {}),
    ...(value.risk ? { risk: value.risk } : {}),
    ...(value.approvalMode ? { approvalMode: value.approvalMode } : {}),
    ...(value.executionMode ? { executionMode: value.executionMode } : {}),
    ...(value.reason ? { reason: safeText(value.reason, OMNI_LIMITS.planDecisionCharacters) } : {}),
    ...(value.output ? { output: safeText(value.output, OMNI_LIMITS.eventOutputCharacters) } : {})
  }
}

function safeTask(value: OmniTask): OmniTask {
  if (!value || typeof value !== 'object' || typeof value.title !== 'string' || typeof value.model !== 'string' ||
      !PROVIDERS.has(value.provider) ||
      !APPROVAL_MODES.has(value.approvalMode) || !EXECUTION_MODES.has(value.executionMode) ||
      !ACTIVATION_SOURCES.has(value.activationSource) || !TASK_STATUSES.has(value.status)) {
    throw new Error('Omni task history is invalid.')
  }
  const id = safeId(value.id, 'task ID')
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt ||
      (value.completedAt !== undefined && (!Number.isSafeInteger(value.completedAt) || value.completedAt < value.createdAt)) ||
      (value.resultSummary !== undefined && typeof value.resultSummary !== 'string') ||
      (value.error !== undefined && typeof value.error !== 'string')) {
    throw new Error('Omni task history has invalid timestamps.')
  }
  if (!Array.isArray(value.events) || value.events.length > OMNI_LIMITS.eventsPerTask) throw new Error('Omni task history is too large.')
  const events = value.events.map((event) => safeEvent(event, id))
  const title = safeText(value.title, OMNI_LIMITS.titleCharacters) || 'Omni task'
  return {
    id,
    title,
    provider: value.provider,
    model: safeText(value.model, OMNI_LIMITS.modelCharacters),
    approvalMode: value.approvalMode,
    executionMode: value.executionMode,
    activationSource: value.activationSource,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.completedAt !== undefined ? { completedAt: value.completedAt } : {}),
    actionCount: events.length,
    ...(value.resultSummary ? { resultSummary: safeText(value.resultSummary, OMNI_LIMITS.resultCharacters) } : {}),
    ...(value.error ? { error: safeText(value.error, OMNI_LIMITS.errorCharacters) } : {}),
    ...(value.plan ? { plan: safePlan(value.plan) } : {}),
    events
  }
}

function safeStore(value: unknown): OmniTaskStoreFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Omni task history is invalid.')
  const record = value as Partial<OmniTaskStoreFile>
  if (record.version !== 1 || !Array.isArray(record.tasks) || record.tasks.length > OMNI_LIMITS.tasks) {
    throw new Error('Omni task history is invalid.')
  }
  const tasks = record.tasks.map(safeTask)
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length ||
      tasks.some((task) => new Set(task.events.map((event) => event.id)).size !== task.events.length)) {
    throw new Error('Omni task history contains duplicate identifiers.')
  }
  return { version: 1, tasks }
}

function summary(task: OmniTask): OmniTaskSummary {
  const result: OmniTaskSummary = {
    id: task.id,
    title: task.title,
    provider: task.provider,
    model: task.model,
    approvalMode: task.approvalMode,
    executionMode: task.executionMode,
    activationSource: task.activationSource,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    actionCount: task.events.length,
    ...(task.resultSummary ? { resultSummary: task.resultSummary } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.plan ? { plan: structuredClone(task.plan) } : {})
  }
  return result
}

export class OmniTaskStore {
  #operation: Promise<void> = Promise.resolve()

  constructor(private readonly storePath: string) {}

  async create(input: {
    title: string
    provider: AIProviderId
    model: string
    approvalMode: WorkApprovalMode
    executionMode: OmniExecutionMode
    activationSource: OmniActivationSource
    plan?: OmniPlan
  }): Promise<OmniTask> {
    const now = Date.now()
    const created = safeTask({
      id: randomUUID(),
      title: input.title,
      provider: input.provider,
      model: input.model,
      approvalMode: input.approvalMode,
      executionMode: input.executionMode,
      activationSource: input.activationSource,
      status: 'planning',
      createdAt: now,
      updatedAt: now,
      actionCount: 0,
      ...(input.plan ? { plan: input.plan } : {}),
      events: []
    })
    await this.#mutate((store) => {
      store.tasks = [created, ...store.tasks].slice(0, OMNI_LIMITS.tasks)
    })
    return structuredClone(created)
  }

  async list(): Promise<OmniTaskSummary[]> {
    await this.#operation
    return (await this.#read()).tasks.map(summary)
  }

  async get(id: string): Promise<OmniTask> {
    safeId(id, 'task ID')
    await this.#operation
    const task = (await this.#read()).tasks.find((candidate) => candidate.id === id)
    if (!task) throw new Error('That Omni task was not found.')
    return structuredClone(task)
  }

  async update(id: string, changes: Partial<Pick<OmniTask, 'status' | 'executionMode' | 'resultSummary' | 'error' | 'completedAt'>>): Promise<OmniTask> {
    safeId(id, 'task ID')
    let result: OmniTask | undefined
    await this.#mutate((store) => {
      const index = store.tasks.findIndex((candidate) => candidate.id === id)
      if (index < 0) throw new Error('That Omni task was not found.')
      result = safeTask({ ...store.tasks[index], ...changes, updatedAt: Date.now() })
      store.tasks[index] = result
    })
    return structuredClone(result as OmniTask)
  }

  async updatePlan(id: string, plan: OmniPlan): Promise<OmniTask> {
    safeId(id, 'task ID')
    const validatedPlan = safePlan(plan)
    let result: OmniTask | undefined
    await this.#mutate((store) => {
      const index = store.tasks.findIndex((candidate) => candidate.id === id)
      if (index < 0) throw new Error('That Omni task was not found.')
      result = safeTask({ ...store.tasks[index], plan: validatedPlan, updatedAt: Date.now() })
      store.tasks[index] = result
    })
    return structuredClone(result as OmniTask)
  }

  async putEvent(taskId: string, value: Omit<OmniEvent, 'id' | 'taskId'> & { id?: string }): Promise<OmniEvent> {
    safeId(taskId, 'task ID')
    const event = safeEvent({ ...value, id: value.id ?? randomUUID(), taskId }, taskId)
    await this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === taskId)
      if (!task) throw new Error('That Omni task was not found.')
      const existing = task.events.findIndex((candidate) => candidate.id === event.id)
      if (existing >= 0) task.events[existing] = event
      else task.events.push(event)
      task.events = task.events.slice(-OMNI_LIMITS.eventsPerTask)
      task.actionCount = task.events.length
      task.updatedAt = Date.now()
    })
    return structuredClone(event)
  }

  async clearHistory(): Promise<void> {
    await this.#mutate((store) => {
      store.tasks = store.tasks.filter((task) => !TERMINAL_STATUSES.has(task.status))
    })
  }

  async recoverInterrupted(now = Date.now()): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Omni recovery time is invalid.')
    let recovered = 0
    await this.#mutate((store) => {
      store.tasks = store.tasks.map((task) => {
        if (TERMINAL_STATUSES.has(task.status)) return task
        recovered++
        const completedAt = Math.max(now, task.createdAt)
        return safeTask({
          ...task,
          status: 'stopped',
          updatedAt: completedAt,
          completedAt,
          resultSummary: 'Interrupted when OmniCode previously closed.',
          error: undefined
        })
      })
    })
    return recovered
  }

  async pruneExpired(retentionDays: number, now = Date.now()): Promise<number> {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > OMNI_LIMITS.activityRetentionDays ||
        !Number.isSafeInteger(now) || now < 0) {
      throw new Error('Omni activity retention is invalid.')
    }
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000
    let removed = 0
    await this.#mutate((store) => {
      const retained = store.tasks.filter((task) => !TERMINAL_STATUSES.has(task.status) || task.updatedAt >= cutoff)
      removed = store.tasks.length - retained.length
      store.tasks = retained
    })
    return removed
  }

  async #mutate(change: (store: OmniTaskStoreFile) => void): Promise<void> {
    const task = this.#operation.then(async () => {
      const store = await this.#read()
      change(store)
      await this.#write(safeStore(store))
    })
    this.#operation = task.catch(() => undefined)
    await task
  }

  async #read(): Promise<OmniTaskStoreFile> {
    try {
      const stat = await fs.stat(this.storePath)
      if (!stat.isFile() || stat.size > OMNI_LIMITS.taskStoreBytes) return defaults()
      return safeStore(JSON.parse(await fs.readFile(this.storePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError ||
          (error instanceof Error && /^Omni\b/u.test(error.message))) {
        return defaults()
      }
      throw error
    }
  }

  async #write(store: OmniTaskStoreFile): Promise<void> {
    const serialized = `${JSON.stringify(store)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > OMNI_LIMITS.taskStoreBytes) throw new Error('Omni task history is too large to save safely.')
    await fs.mkdir(path.dirname(this.storePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, serialized, { mode: 0o600 })
      await fs.rename(temporaryPath, this.storePath)
      await fs.chmod(this.storePath, 0o600)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}
