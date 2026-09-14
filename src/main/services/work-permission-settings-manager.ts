import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { WorkApprovalMode, WorkPermissionSettings } from '../../shared/tool-contracts'

const MODES = new Set<WorkApprovalMode>(['ask', 'auto', 'full'])
const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u
const MAX_STORE_BYTES = 64 * 1024

function defaults(): WorkPermissionSettings {
  return { version: 1, globalMode: 'ask', connectorOverrides: {}, fullAccessWarningAcknowledged: false }
}

function clone(value: WorkPermissionSettings): WorkPermissionSettings {
  return { ...value, connectorOverrides: { ...value.connectorOverrides } }
}

function validateMode(value: unknown): asserts value is WorkApprovalMode {
  if (typeof value !== 'string' || !MODES.has(value as WorkApprovalMode)) {
    throw new Error('Choose Ask for approval, Approve for me, or Full access.')
  }
}

function validate(value: unknown): WorkPermissionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Work action settings are invalid.')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('Work action settings use an unsupported version.')
  validateMode(record.globalMode)
  if (typeof record.fullAccessWarningAcknowledged !== 'boolean') throw new Error('Work Full Access acknowledgement is invalid.')
  if (!record.connectorOverrides || typeof record.connectorOverrides !== 'object' || Array.isArray(record.connectorOverrides)) {
    throw new Error('Work connector permission overrides are invalid.')
  }
  const overrides: Record<string, WorkApprovalMode> = {}
  for (const [connectorId, mode] of Object.entries(record.connectorOverrides)) {
    if (!CONNECTOR_ID_PATTERN.test(connectorId)) throw new Error('A Work connector permission override has an invalid connector ID.')
    validateMode(mode)
    overrides[connectorId] = mode
  }
  return {
    version: 1,
    globalMode: record.globalMode,
    connectorOverrides: overrides,
    fullAccessWarningAcknowledged: record.fullAccessWarningAcknowledged
  }
}

export class WorkPermissionSettingsManager {
  #operation: Promise<void> = Promise.resolve()

  constructor(private readonly storePath: string) {}

  async get(): Promise<WorkPermissionSettings> {
    await this.#operation
    return this.#read()
  }

  async setGlobal(mode: WorkApprovalMode, acknowledgeFullAccess = false): Promise<WorkPermissionSettings> {
    validateMode(mode)
    return this.#update((current) => {
      this.#assertFullAccessAcknowledged(current, mode, acknowledgeFullAccess)
      return {
        ...current,
        globalMode: mode,
        fullAccessWarningAcknowledged: current.fullAccessWarningAcknowledged || (mode === 'full' && acknowledgeFullAccess)
      }
    })
  }

  async setConnector(connectorId: string, mode: WorkApprovalMode | null, acknowledgeFullAccess = false): Promise<WorkPermissionSettings> {
    if (!CONNECTOR_ID_PATTERN.test(connectorId)) throw new Error('Work connector permission override has an invalid connector ID.')
    if (mode !== null) validateMode(mode)
    return this.#update((current) => {
      if (mode) this.#assertFullAccessAcknowledged(current, mode, acknowledgeFullAccess)
      const connectorOverrides = { ...current.connectorOverrides }
      if (mode === null) delete connectorOverrides[connectorId]
      else connectorOverrides[connectorId] = mode
      return {
        ...current,
        connectorOverrides,
        fullAccessWarningAcknowledged: current.fullAccessWarningAcknowledged || (mode === 'full' && acknowledgeFullAccess)
      }
    })
  }

  effectiveMode(settings: WorkPermissionSettings, connectorId: string): WorkApprovalMode {
    if (!CONNECTOR_ID_PATTERN.test(connectorId)) throw new Error('Work connector ID is invalid.')
    return settings.connectorOverrides[connectorId] ?? settings.globalMode
  }

  #assertFullAccessAcknowledged(current: WorkPermissionSettings, mode: WorkApprovalMode, acknowledged: boolean): void {
    if (mode === 'full' && !current.fullAccessWarningAcknowledged && acknowledged !== true) {
      throw new Error('Confirm the Full Access warning before enabling this permission mode.')
    }
  }

  async #update(change: (current: WorkPermissionSettings) => WorkPermissionSettings): Promise<WorkPermissionSettings> {
    let result = defaults()
    const task = this.#operation.then(async () => {
      const current = await this.#read()
      result = validate(change(current))
      await this.#write(result)
    })
    this.#operation = task.catch(() => undefined)
    await task
    return clone(result)
  }

  async #read(): Promise<WorkPermissionSettings> {
    let value: string
    try {
      const stat = await fs.stat(this.storePath)
      if (stat.size > MAX_STORE_BYTES) return defaults()
      value = await fs.readFile(this.storePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults()
      throw error
    }
    try {
      return clone(validate(JSON.parse(value)))
    } catch {
      // Invalid settings fail closed to the safest migration/default mode.
      return defaults()
    }
  }

  async #write(settings: WorkPermissionSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporaryPath, this.storePath)
      await fs.chmod(this.storePath, 0o600)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}
