import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { NOTIFICATION_LIMITS } from '../../shared/notification-contracts'
import { NotificationManager, sanitizeNotificationText } from './notification-manager'

const temporaryDirectories: string[] = []

async function manager(options: ConstructorParameters<typeof NotificationManager>[1] = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-notifications-'))
  temporaryDirectories.push(directory)
  return new NotificationManager(path.join(directory, 'notifications.json'), options)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('NotificationManager', () => {
  it('creates ordered notifications, tracks unread state, and persists conversation links', async () => {
    let now = 100
    let id = 0
    const notifications = await manager({ now: () => ++now, createId: () => `notification-${++id}` })
    await notifications.create({
      type: 'TASK_COMPLETED', title: 'Task completed', description: 'Code task finished.',
      sourceMode: 'code', severity: 'success', taskId: 'task-123',
      actionTarget: { mode: 'code', taskId: 'task-123' }
    })
    const snapshot = await notifications.create({
      type: 'EMAIL_SENT', title: 'Email sent', description: 'The Gmail message was sent.',
      sourceMode: 'work', severity: 'success', conversationId: 'conversation-123', taskId: 'request-123',
      actionTarget: { mode: 'work', conversationId: 'conversation-123', taskId: 'request-123' }
    })

    expect(snapshot.notifications.map((item) => item.id)).toEqual(['notification-2', 'notification-1'])
    expect(snapshot.unreadCount).toBe(2)
    expect(snapshot.notifications[0].actionTarget).toEqual({ mode: 'work', conversationId: 'conversation-123', taskId: 'request-123' })
    expect((await notifications.markRead('notification-2')).unreadCount).toBe(1)
    expect((await notifications.markAllRead()).unreadCount).toBe(0)
  })

  it('clears one or all notifications without touching linked conversation data', async () => {
    let id = 0
    const notifications = await manager({ createId: () => `notification-${++id}` })
    for (const title of ['First', 'Second']) await notifications.create({
      type: 'TASK_COMPLETED', title, description: 'Complete', sourceMode: 'work', severity: 'success', conversationId: 'conversation-1'
    })
    expect((await notifications.remove('notification-1')).notifications).toHaveLength(1)
    expect((await notifications.clear()).notifications).toHaveLength(0)
  })

  it('sanitizes secrets before persistence and native delivery', async () => {
    const showNative = vi.fn()
    const notifications = await manager({ createId: () => 'notification-safe', showNative })
    await notifications.updateSettings({ nativeMacOS: true })
    const snapshot = await notifications.create({
      type: 'TASK_FAILED', title: 'Request failed',
      description: 'Authorization: Bearer secret-token client_secret=private refresh_token=refresh-me',
      sourceMode: 'code', severity: 'error'
    })
    expect(snapshot.notifications[0].description).not.toMatch(/secret-token|private|refresh-me/u)
    expect(showNative).toHaveBeenCalledWith('Request failed', expect.stringContaining('[REDACTED]'))
  })

  it('prunes the persisted history to the newest bounded set', async () => {
    let id = 0
    const notifications = await manager({ now: () => id, createId: () => `notification-${++id}` })
    for (let index = 0; index < NOTIFICATION_LIMITS.notifications + 5; index++) {
      await notifications.create({
        type: 'BACKGROUND_TASK_COMPLETED', title: `Task ${index}`, description: 'Complete', sourceMode: 'system', severity: 'success'
      })
    }
    const snapshot = await notifications.snapshot()
    expect(snapshot.notifications).toHaveLength(NOTIFICATION_LIMITS.notifications)
    expect(snapshot.notifications[0].id).toBe(`notification-${NOTIFICATION_LIMITS.notifications + 5}`)
  })

  it('honors concise notification settings independently', async () => {
    const notifications = await manager({ createId: () => 'notification-1' })
    await notifications.updateSettings({ emailSent: false })
    const snapshot = await notifications.create({
      type: 'EMAIL_SENT', title: 'Email sent', description: 'Complete', sourceMode: 'work', severity: 'success'
    })
    expect(snapshot.notifications).toEqual([])
    expect(snapshot.settings.emailSent).toBe(false)
  })
})

describe('sanitizeNotificationText', () => {
  it('removes keys, authorization values, cookies, control characters, and query tokens', () => {
    const value = sanitizeNotificationText('sk-secretkey123 Authorization=Bearer abc cookie=session123 https://x.test/?access_token=abc\nokay', 500)
    expect(value).not.toMatch(/secretkey123|session123|access_token=abc|Bearer abc/u)
    expect(value).toContain('okay')
  })
})
