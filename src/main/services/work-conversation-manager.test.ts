import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WORK_CONVERSATION_LIMITS, type WorkAttachment, type WorkToolActivity } from '../../shared/work-contracts'
import { WorkConversationManager, WorkConversationStoreCorruptError } from './work-conversation-manager'

const temporaryDirectories: string[] = []

async function fixture(): Promise<{ root: string; storagePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-work-conversations-'))
  temporaryDirectories.push(root)
  return { root, storagePath: path.join(root, 'state', 'work-conversations.json') }
}

function deterministicManager(storagePath: string): WorkConversationManager {
  let timestamp = 1_700_000_000_000
  let id = 0
  return new WorkConversationManager(storagePath, {
    now: () => timestamp++,
    createId: () => `generated-${++id}`
  })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('WorkConversationManager', () => {
  it('persists CRUD, pin, rename, and model operations with UI-ready summaries', async () => {
    const { storagePath } = await fixture()
    const manager = deterministicManager(storagePath)
    const first = await manager.create({ title: 'Project planning', provider: 'google', modelId: 'gemini-3.5-flash' })
    const second = await manager.create()

    expect(first).toMatchObject({
      id: 'generated-1', title: 'Project planning', pinned: false,
      provider: 'google', modelId: 'gemini-3.5-flash', messageCount: 0, messages: []
    })
    expect(second).toMatchObject({ title: 'New chat', provider: 'ollama', modelId: '' })

    await manager.rename(first.id, 'Friday plan')
    await manager.setModel(first.id, 'openai', 'gpt-5.1')
    await manager.setPinned(first.id, true)
    const summaries = await manager.list()
    expect(summaries).toEqual([
      expect.objectContaining({ id: first.id, title: 'Friday plan', pinned: true, provider: 'openai', modelId: 'gpt-5.1', messageCount: 0 }),
      expect.objectContaining({ id: second.id, pinned: false })
    ])
    expect(summaries[0]).not.toHaveProperty('messages')

    const reopened = new WorkConversationManager(storagePath)
    expect(await reopened.get(first.id)).toMatchObject({ title: 'Friday plan', provider: 'openai', modelId: 'gpt-5.1' })
    await reopened.delete(second.id)
    await expect(reopened.get(second.id)).rejects.toThrow(/not found/i)
    expect((await reopened.list()).map((item) => item.id)).toEqual([first.id])
  })

  it('persists messages, attachment metadata, and safe tool activity summaries', async () => {
    const { storagePath } = await fixture()
    const manager = deterministicManager(storagePath)
    const conversation = await manager.create({ title: 'Research' })
    const attachment: WorkAttachment = {
      id: 'attachment-1',
      name: 'agenda.pdf',
      kind: 'connected-resource',
      source: 'connected-app',
      createdAt: 1_700_000_000_100,
      mimeType: 'application/pdf',
      sizeBytes: 42_000,
      connectorId: 'google-drive',
      resourceId: 'drive-file-42'
    }
    const activity: WorkToolActivity = {
      id: 'activity-1',
      toolId: 'drive-read',
      connectorId: 'google-drive',
      name: 'Read document',
      status: 'succeeded',
      summary: 'Read the selected document.',
      preview: {
        kind: 'drive-file', label: 'Google Drive file', count: 1,
        items: [{ title: 'agenda.pdf', subtitle: 'application/pdf', metadata: '42 KB' }]
      },
      createdAt: 1_700_000_000_101,
      completedAt: 1_700_000_000_102
    }
    const assistant = await manager.addMessage(conversation.id, {
      role: 'assistant', content: '', status: 'pending', attachments: [attachment]
    })
    attachment.name = 'caller mutation.pdf'
    await manager.updateMessage(conversation.id, assistant.id, {
      content: 'The launch date is Friday.', status: 'complete', toolActivities: [activity]
    })
    await manager.addMessage(conversation.id, { role: 'user', content: 'Summarize the launch agenda.' })

    const reopened = await new WorkConversationManager(storagePath).get(conversation.id)
    expect(reopened.messageCount).toBe(2)
    expect(reopened.messages[0]).toMatchObject({
      role: 'assistant', content: 'The launch date is Friday.', status: 'complete',
      attachments: [{ name: 'agenda.pdf', resourceId: 'drive-file-42' }],
      toolActivities: [{
        name: 'Read document', status: 'succeeded',
        preview: { kind: 'drive-file', items: [{ title: 'agenda.pdf' }] }
      }]
    })
    expect(await manager.search({ query: 'LAUNCH DATE' })).toEqual([
      expect.objectContaining({ id: conversation.id, messageCount: 2 })
    ])

    const afterDelete = await manager.deleteMessage(conversation.id, reopened.messages[1].id)
    expect(afterDelete.messageCount).toBe(1)
    expect((await manager.clearMessages(conversation.id)).messages).toEqual([])
  })

  it('sorts pinned and recently updated conversations and bounds search results', async () => {
    const { storagePath } = await fixture()
    const manager = deterministicManager(storagePath)
    const first = await manager.create({ title: 'Alpha notes' })
    const second = await manager.create({ title: 'Beta notes' })
    const third = await manager.create({ title: 'Gamma' })
    await manager.addMessage(third.id, { role: 'user', content: 'The alpha detail lives here.' })
    await manager.setPinned(first.id, true)

    expect((await manager.list()).map((item) => item.id)).toEqual([first.id, third.id, second.id])
    expect((await manager.search({ query: 'alpha', limit: 1 })).map((item) => item.id)).toEqual([first.id])
    expect((await manager.search({ limit: 2 })).map((item) => item.id)).toEqual([first.id, third.id])
    await expect(manager.search({ query: 'x'.repeat(WORK_CONVERSATION_LIMITS.searchCharacters + 1) })).rejects.toThrow(/too long/i)
    await expect(manager.search({ limit: 0 })).rejects.toThrow(/between 1/i)
  })

  it('serializes concurrent mutations and atomically writes a private store', async () => {
    const { root, storagePath } = await fixture()
    const manager = deterministicManager(storagePath)
    await Promise.all(Array.from({ length: 30 }, (_, index) => manager.create({ title: `Conversation ${index}` })))

    const conversations = await manager.list()
    expect(conversations).toHaveLength(30)
    expect(new Set(conversations.map((item) => item.id)).size).toBe(30)
    expect(JSON.parse(await fs.readFile(storagePath, 'utf8')).conversations).toHaveLength(30)
    expect((await fs.stat(storagePath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(storagePath))).mode & 0o777).toBe(0o700)
    expect((await fs.readdir(path.dirname(storagePath))).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(await fs.readdir(root)).toEqual(['state'])
  })

  it('rejects invalid IDs, enums, sizes, relationship metadata, and secret-shaped fields', async () => {
    const { storagePath } = await fixture()
    const manager = deterministicManager(storagePath)
    const conversation = await manager.create()

    await expect(manager.get('../escape')).rejects.toThrow(/ID is invalid/i)
    expect(() => manager.create({ title: 'bad\ntitle' })).toThrow(/single-line/i)
    expect(() => manager.create({ provider: 'unsupported' as 'ollama' })).toThrow(/provider/i)
    expect(() => manager.create({ modelId: 'bad model id' })).toThrow(/modelId/i)
    expect(() => manager.create({ title: 'Secret', accessToken: 'do-not-store' } as never)).toThrow(/unsupported field: accessToken/i)
    expect(() => manager.setModel(conversation.id, 'google', '')).toThrow(/choose a model/i)
    expect(() => manager.addMessage(conversation.id, {
      role: 'user', content: 'x'.repeat(WORK_CONVERSATION_LIMITS.messageBytes + 1)
    })).toThrow(/128 KiB/i)
    expect(() => manager.addMessage(conversation.id, {
      role: 'user', content: 'attachment', attachments: [{
        id: 'attachment-1', name: 'mail.txt', kind: 'connected-resource', source: 'connected-app',
        createdAt: 1, resourceId: 'mail-1'
      }]
    })).toThrow(/connectorId/i)
    expect(() => manager.addMessage(conversation.id, {
      role: 'assistant', content: '', toolActivities: [{
        id: 'activity-1', toolId: 'mail-send', name: 'Send mail', status: 'approved' as 'pending', createdAt: 1
      }]
    })).toThrow(/status is invalid/i)
    expect(() => manager.addMessage(conversation.id, {
      role: 'assistant', content: '', toolActivities: [{
        id: 'activity-2', toolId: 'gmail.search', name: 'Search mail', status: 'succeeded', createdAt: 1,
        preview: { kind: 'gmail-messages', label: 'Results', items: [{ title: 'Safe', messageId: 'must-not-persist' }] }
      }]
    } as never)).toThrow(/unsupported field: messageId/i)
  })

  it('enforces conversation and message count limits from persisted data', async () => {
    const { storagePath } = await fixture()
    await fs.mkdir(path.dirname(storagePath), { recursive: true })
    const messages = Array.from({ length: WORK_CONVERSATION_LIMITS.messagesPerConversation }, (_, index) => ({
      id: `message-${index}`, role: 'assistant', content: '', createdAt: index
    }))
    await fs.writeFile(storagePath, JSON.stringify({
      version: 1,
      conversations: [{
        id: 'conversation-1', title: 'Full', createdAt: 0, updatedAt: 1_000,
        pinned: false, provider: 'ollama', modelId: '', messageCount: messages.length, messages
      }]
    }))
    const manager = deterministicManager(storagePath)
    await expect(manager.addMessage('conversation-1', { role: 'user', content: 'one too many' })).rejects.toThrow(/message limit/i)

    const conversations = Array.from({ length: WORK_CONVERSATION_LIMITS.conversations }, (_, index) => ({
      id: `conversation-${index}`, title: `Conversation ${index}`, createdAt: index, updatedAt: index,
      pinned: false, provider: 'ollama', modelId: '', messageCount: 0, messages: []
    }))
    await fs.writeFile(storagePath, JSON.stringify({ version: 1, conversations }))
    await expect(manager.create()).rejects.toThrow(/conversation limit/i)
  })

  it('does not silently overwrite corruption and supports explicit recover-with-backup', async () => {
    const { storagePath } = await fixture()
    await fs.mkdir(path.dirname(storagePath), { recursive: true })
    const corrupt = '{"version":1,"conversations":['
    await fs.writeFile(storagePath, corrupt, { mode: 0o600 })
    const manager = deterministicManager(storagePath)

    await expect(manager.list()).rejects.toBeInstanceOf(WorkConversationStoreCorruptError)
    await expect(manager.create()).rejects.toBeInstanceOf(WorkConversationStoreCorruptError)
    expect(await fs.readFile(storagePath, 'utf8')).toBe(corrupt)

    const recovery = await manager.recoverCorruptStore()
    expect(recovery.recovered).toBe(true)
    expect(recovery.backupPath).toBeTruthy()
    expect(await fs.readFile(recovery.backupPath!, 'utf8')).toBe(corrupt)
    expect((await fs.stat(recovery.backupPath!)).mode & 0o777).toBe(0o600)
    expect(await manager.list()).toEqual([])
    await expect(manager.create({ title: 'Recovered history' })).resolves.toMatchObject({ title: 'Recovered history' })
    await expect(manager.recoverCorruptStore()).resolves.toEqual({ recovered: false })
  })

  it('rejects unsupported or secret-bearing persisted shapes and oversized stores', async () => {
    const { storagePath } = await fixture()
    await fs.mkdir(path.dirname(storagePath), { recursive: true })
    await fs.writeFile(storagePath, JSON.stringify({ version: 1, conversations: [], refreshToken: 'must-not-persist' }))
    await expect(new WorkConversationManager(storagePath).list()).rejects.toThrow(/unsupported field: refreshToken/i)

    await fs.writeFile(storagePath, ' '.repeat(WORK_CONVERSATION_LIMITS.storeBytes + 1))
    await expect(new WorkConversationManager(storagePath).list()).rejects.toThrow(/too large/i)
  })

  it('refuses symbolic-link storage without changing its target', async () => {
    const { root, storagePath } = await fixture()
    const outside = path.join(root, 'outside.json')
    const original = '{"protected":true}'
    await fs.writeFile(outside, original)
    await fs.mkdir(path.dirname(storagePath), { recursive: true })
    await fs.symlink(outside, storagePath)
    const manager = deterministicManager(storagePath)

    await expect(manager.list()).rejects.toThrow(/regular file/i)
    await expect(manager.recoverCorruptStore()).rejects.toThrow(/regular file/i)
    expect(await fs.readFile(outside, 'utf8')).toBe(original)
  })

  it('requires an absolute injected storage path and returns defensive copies', async () => {
    expect(() => new WorkConversationManager('relative/history.json')).toThrow(/absolute file path/i)
    const { storagePath } = await fixture()
    const manager = deterministicManager(storagePath)
    const created = await manager.create({ title: 'Original' })
    created.title = 'Caller mutation'
    expect((await manager.get(created.id)).title).toBe('Original')
    await expect(manager.update('missing-id', { title: 'Nope' })).rejects.toThrow(/not found/i)
  })
})
