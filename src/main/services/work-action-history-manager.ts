import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { WorkActionHistoryEntry } from '../../shared/tool-contracts'
import { redactDiagnosticMessage } from './diagnostic-logger'

const MAX_ENTRIES = 500
const MAX_STORE_BYTES = 1024 * 1024

interface WorkActionHistoryStore {
  version: 1
  entries: WorkActionHistoryEntry[]
}

const CATEGORIES = new Set(['read', 'write', 'communication', 'destructive', 'external-submission', 'system', 'financial', 'account-security', 'sensitive-data'])
const RISKS = new Set(['low', 'medium', 'high', 'critical'])
const MODES = new Set(['ask', 'auto', 'full'])
const APPROVALS = new Set(['automatic', 'user-approved', 'user-cancelled', 'blocked'])
const RESULTS = new Set(['succeeded', 'failed', 'cancelled', 'blocked'])

function emptyStore(): WorkActionHistoryStore { return { version: 1, entries: [] } }

function safeEntry(value: WorkActionHistoryEntry): WorkActionHistoryEntry {
  if (!value || typeof value !== 'object') throw new Error('Work action history is invalid.')
  if (![value.id, value.toolId, value.toolName, value.connectorId, value.connectorName, value.summary].every((entry) => typeof entry === 'string')) {
    throw new Error('Work action history is invalid.')
  }
  if (!Number.isFinite(value.timestamp) || !Number.isFinite(value.completedAt) || value.timestamp < 0 || value.completedAt < value.timestamp) {
    throw new Error('Work action history is invalid.')
  }
  if (!CATEGORIES.has(value.category) || !RISKS.has(value.risk) || !MODES.has(value.approvalMode) || !APPROVALS.has(value.approval) || !RESULTS.has(value.result)) {
    throw new Error('Work action history is invalid.')
  }
  return {
    ...value,
    id: String(value.id).slice(0, 128),
    toolId: String(value.toolId).slice(0, 128),
    toolName: String(value.toolName).replace(/[\r\n\0]/gu, ' ').slice(0, 160),
    connectorId: String(value.connectorId).slice(0, 64),
    connectorName: String(value.connectorName).replace(/[\r\n\0]/gu, ' ').slice(0, 120),
    summary: redactDiagnosticMessage(value.summary).replace(/[\r\n\0]/gu, ' ').slice(0, 500)
  }
}

function validateStore(value: unknown): WorkActionHistoryStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Work action history is invalid.')
  const record = value as Partial<WorkActionHistoryStore>
  if (record.version !== 1 || !Array.isArray(record.entries) || record.entries.length > MAX_ENTRIES) {
    throw new Error('Work action history is invalid.')
  }
  return { version: 1, entries: record.entries.map((entry) => safeEntry(entry)) }
}

export class WorkActionHistoryManager {
  #operation: Promise<void> = Promise.resolve()

  constructor(private readonly storePath: string) {}

  async list(limit = 200): Promise<WorkActionHistoryEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ENTRIES) throw new Error('Work activity limit is invalid.')
    await this.#operation
    const store = await this.#read()
    return store.entries.slice(0, limit).map((entry) => ({ ...entry }))
  }

  async add(entry: Omit<WorkActionHistoryEntry, 'id'>): Promise<WorkActionHistoryEntry> {
    const created = safeEntry({ ...entry, id: randomUUID() })
    const task = this.#operation.then(async () => {
      const store = await this.#read()
      store.entries = [created, ...store.entries].slice(0, MAX_ENTRIES)
      await this.#write(store)
    })
    this.#operation = task.catch(() => undefined)
    await task
    return { ...created }
  }

  async clear(): Promise<void> {
    const task = this.#operation.then(() => this.#write(emptyStore()))
    this.#operation = task.catch(() => undefined)
    await task
  }

  async #read(): Promise<WorkActionHistoryStore> {
    try {
      const stat = await fs.stat(this.storePath)
      if (stat.size > MAX_STORE_BYTES) return emptyStore()
      return validateStore(JSON.parse(await fs.readFile(this.storePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError || (error instanceof Error && /history is invalid/u.test(error.message))) {
        return emptyStore()
      }
      throw error
    }
  }

  async #write(store: WorkActionHistoryStore): Promise<void> {
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
