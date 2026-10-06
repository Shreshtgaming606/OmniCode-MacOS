import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  CreateOmniNotification,
  NotificationSettings,
  NotificationSnapshot,
  NotificationSourceMode,
  NotificationType,
  OmniNotification
} from '../../shared/notification-contracts'
import { NOTIFICATION_LIMITS } from '../../shared/notification-contracts'
import { redactDiagnosticMessage } from './diagnostic-logger'

interface NotificationStore {
  version: 1
  settings: NotificationSettings
  notifications: OmniNotification[]
}

interface NotificationManagerOptions {
  now?: () => number
  createId?: () => string
  showNative?(title: string, body: string): void
}

const TYPES = new Set<NotificationType>([
  'TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED', 'BUILD_COMPLETED', 'BUILD_FAILED',
  'TESTS_COMPLETED', 'TESTS_FAILED', 'EMAIL_SENT', 'EMAIL_FAILED', 'DRIVE_UPLOAD_COMPLETED',
  'DRIVE_UPLOAD_FAILED', 'DOWNLOAD_COMPLETED', 'DOWNLOAD_FAILED', 'MODEL_LOADED',
  'MODEL_DOWNLOAD_COMPLETED', 'BACKGROUND_TASK_COMPLETED', 'BACKGROUND_TASK_FAILED',
  'CONNECTOR_ERROR', 'SYSTEM_WARNING'
])
const MODES = new Set<NotificationSourceMode>(['code', 'work', 'omni', 'system'])
const SEVERITIES = new Set(['info', 'success', 'warning', 'error'])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

function defaultSettings(): NotificationSettings {
  return {
    version: 1,
    inApp: true,
    nativeMacOS: false,
    backgroundCompletions: true,
    failures: true,
    emailSent: true,
    buildFinished: true
  }
}

function defaults(): NotificationStore {
  return { version: 1, settings: defaultSettings(), notifications: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined
}

/**
 * Notification text is always a display-only projection. It never stores raw
 * tool payloads, headers, command output, or provider response bodies.
 */
export function sanitizeNotificationText(value: unknown, maximum: number): string {
  return redactDiagnosticMessage(value)
    .replace(/\b(?:cookie|set-cookie)\s*[:=]\s*[^,;\s]+/giu, 'cookie: [REDACTED]')
    .replace(/\b(refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*[^,;\s]+/giu, '$1: [REDACTED]')
    .slice(0, maximum)
}

function safeSettings(value: unknown): NotificationSettings {
  const fallback = defaultSettings()
  if (!isRecord(value)) return fallback
  return {
    version: 1,
    inApp: typeof value.inApp === 'boolean' ? value.inApp : fallback.inApp,
    nativeMacOS: typeof value.nativeMacOS === 'boolean' ? value.nativeMacOS : fallback.nativeMacOS,
    backgroundCompletions: typeof value.backgroundCompletions === 'boolean' ? value.backgroundCompletions : fallback.backgroundCompletions,
    failures: typeof value.failures === 'boolean' ? value.failures : fallback.failures,
    emailSent: typeof value.emailSent === 'boolean' ? value.emailSent : fallback.emailSent,
    buildFinished: typeof value.buildFinished === 'boolean' ? value.buildFinished : fallback.buildFinished
  }
}

function safeNotification(value: unknown): OmniNotification | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !TYPES.has(value.type as NotificationType)) return undefined
  if (typeof value.sourceMode !== 'string' || !MODES.has(value.sourceMode as NotificationSourceMode)) return undefined
  if (typeof value.severity !== 'string' || !SEVERITIES.has(value.severity)) return undefined
  const id = safeId(value.id)
  if (!id || !Number.isSafeInteger(value.timestamp) || Number(value.timestamp) < 0) return undefined
  const conversationId = safeId(value.conversationId)
  const taskId = safeId(value.taskId)
  const target = isRecord(value.actionTarget) && typeof value.actionTarget.mode === 'string' && ['code', 'work', 'omni'].includes(value.actionTarget.mode)
    ? {
        mode: value.actionTarget.mode as 'code' | 'work' | 'omni',
        ...(safeId(value.actionTarget.conversationId) ? { conversationId: safeId(value.actionTarget.conversationId) } : {}),
        ...(safeId(value.actionTarget.taskId) ? { taskId: safeId(value.actionTarget.taskId) } : {})
      }
    : undefined
  return {
    id,
    type: value.type as NotificationType,
    title: sanitizeNotificationText(value.title, NOTIFICATION_LIMITS.titleCharacters),
    description: sanitizeNotificationText(value.description, NOTIFICATION_LIMITS.descriptionCharacters),
    timestamp: Number(value.timestamp),
    read: value.read === true,
    sourceMode: value.sourceMode as NotificationSourceMode,
    severity: value.severity as OmniNotification['severity'],
    ...(conversationId ? { conversationId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(target ? { actionTarget: target } : {})
  }
}

function safeStore(value: unknown): NotificationStore {
  if (!isRecord(value)) return defaults()
  const notifications = Array.isArray(value.notifications)
    ? value.notifications.flatMap((item) => safeNotification(item) ?? []).sort((left, right) => right.timestamp - left.timestamp).slice(0, NOTIFICATION_LIMITS.notifications)
    : []
  return { version: 1, settings: safeSettings(value.settings), notifications }
}

function shouldCreate(settings: NotificationSettings, value: CreateOmniNotification): boolean {
  if (!settings.inApp) return false
  if (value.severity === 'error' && !settings.failures) return false
  if (value.type === 'EMAIL_SENT' && !settings.emailSent) return false
  if ((value.type === 'BUILD_COMPLETED' || value.type === 'BUILD_FAILED') && !settings.buildFinished) return false
  if ((value.type === 'BACKGROUND_TASK_COMPLETED' || value.type === 'BACKGROUND_TASK_FAILED') && !settings.backgroundCompletions) return false
  return true
}

function shouldShowNative(settings: NotificationSettings, value: OmniNotification): boolean {
  if (!settings.nativeMacOS) return false
  if (value.severity === 'error') return settings.failures
  if (value.type === 'EMAIL_SENT') return settings.emailSent
  if (value.type === 'BUILD_COMPLETED') return settings.buildFinished
  if (value.type === 'BACKGROUND_TASK_COMPLETED') return settings.backgroundCompletions
  return ['TASK_COMPLETED', 'TASK_CANCELLED', 'MODEL_DOWNLOAD_COMPLETED', 'DOWNLOAD_COMPLETED'].includes(value.type)
}

export class NotificationManager {
  private operation: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly createId: () => string

  constructor(readonly storePath: string, private readonly options: NotificationManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.createId = options.createId ?? randomUUID
  }

  async snapshot(): Promise<NotificationSnapshot> {
    await this.operation
    const store = await this.read()
    return this.toSnapshot(store)
  }

  async create(value: CreateOmniNotification): Promise<NotificationSnapshot> {
    let created: OmniNotification | undefined
    await this.mutate((store) => {
      if (!shouldCreate(store.settings, value)) return
      created = safeNotification({
        ...value,
        id: this.createId(),
        timestamp: this.now(),
        read: false
      })
      if (!created) throw new Error('The notification is invalid.')
      store.notifications = [created, ...store.notifications.filter((item) => item.id !== created!.id)].slice(0, NOTIFICATION_LIMITS.notifications)
    })
    const snapshot = await this.snapshot()
    if (created && shouldShowNative(snapshot.settings, created)) this.options.showNative?.(created.title, created.description)
    return snapshot
  }

  async markRead(id: string, read = true): Promise<NotificationSnapshot> {
    await this.mutate((store) => {
      const item = store.notifications.find((candidate) => candidate.id === id)
      if (!item) throw new Error('That notification was not found.')
      item.read = read
    })
    return this.snapshot()
  }

  async markAllRead(): Promise<NotificationSnapshot> {
    await this.mutate((store) => { for (const item of store.notifications) item.read = true })
    return this.snapshot()
  }

  async remove(id: string): Promise<NotificationSnapshot> {
    await this.mutate((store) => { store.notifications = store.notifications.filter((item) => item.id !== id) })
    return this.snapshot()
  }

  async clear(): Promise<NotificationSnapshot> {
    await this.mutate((store) => { store.notifications = [] })
    return this.snapshot()
  }

  async updateSettings(changes: Partial<Omit<NotificationSettings, 'version'>>): Promise<NotificationSnapshot> {
    await this.mutate((store) => { store.settings = safeSettings({ ...store.settings, ...changes }) })
    return this.snapshot()
  }

  private toSnapshot(store: NotificationStore): NotificationSnapshot {
    return {
      notifications: structuredClone(store.notifications),
      unreadCount: store.notifications.filter((item) => !item.read).length,
      settings: { ...store.settings }
    }
  }

  private async mutate(change: (store: NotificationStore) => void): Promise<void> {
    const next = this.operation.then(async () => {
      const store = await this.read()
      change(store)
      await this.write(safeStore(store))
    })
    this.operation = next.catch(() => undefined)
    await next
  }

  private async read(): Promise<NotificationStore> {
    try {
      const stat = await fs.stat(this.storePath)
      if (!stat.isFile() || stat.size > NOTIFICATION_LIMITS.storeBytes) return defaults()
      return safeStore(JSON.parse(await fs.readFile(this.storePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return defaults()
      throw error
    }
  }

  private async write(store: NotificationStore): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await handle.writeFile(JSON.stringify(store), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, this.storePath)
    await fs.chmod(this.storePath, 0o600)
  }
}
