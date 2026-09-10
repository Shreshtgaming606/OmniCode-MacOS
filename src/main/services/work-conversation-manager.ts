import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  CreateWorkConversationRequest,
  CreateWorkMessageRequest,
  RecoverWorkConversationStoreResult,
  UpdateWorkConversationRequest,
  UpdateWorkMessageRequest,
  WorkAttachment,
  WorkConversation,
  WorkConversationSearchRequest,
  WorkConversationSummary,
  WorkMessage,
  WorkToolActivity,
  WorkToolPreview
} from '../../shared/work-contracts'
import { WORK_CONVERSATION_LIMITS } from '../../shared/work-contracts'

const STORE_VERSION = 1
const PROVIDERS = new Set(['ollama', 'openai', 'anthropic', 'google'])
const MESSAGE_ROLES = new Set(['user', 'assistant'])
const MESSAGE_STATUSES = new Set(['pending', 'streaming', 'complete', 'failed', 'cancelled'])
const ATTACHMENT_KINDS = new Set(['file', 'image', 'connected-resource'])
const ATTACHMENT_SOURCES = new Set(['computer', 'connected-app'])
const TOOL_STATUSES = new Set(['pending', 'running', 'awaiting-confirmation', 'succeeded', 'failed', 'cancelled'])
const TOOL_PREVIEW_KINDS = new Set(['gmail-messages', 'gmail-message', 'gmail-draft', 'drive-files', 'drive-file', 'transferred-file'])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/u
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u

interface WorkConversationStore {
  version: typeof STORE_VERSION
  conversations: WorkConversation[]
}

interface WorkConversationManagerOptions {
  now?: () => number
  createId?: () => string
}

export class WorkConversationStoreCorruptError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'WorkConversationStoreCorruptError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected) throw new Error(`${label} contains an unsupported field: ${unexpected}.`)
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label} is invalid.`)
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a valid timestamp.`)
}

function assertBoundedText(value: unknown, label: string, maxCharacters: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > maxCharacters || /[\0\r\n]/u.test(value) || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} single-line string no longer than ${maxCharacters} characters.`)
  }
}

function assertContent(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > WORK_CONVERSATION_LIMITS.messageBytes) {
    throw new Error(`${label} must be valid text no larger than ${WORK_CONVERSATION_LIMITS.messageBytes / 1024} KiB.`)
  }
}

function validateAttachment(value: unknown, label: string): asserts value is WorkAttachment {
  if (!isRecord(value)) throw new Error(`${label} must be an attachment object.`)
  assertAllowedKeys(value, ['id', 'name', 'kind', 'source', 'createdAt', 'mimeType', 'sizeBytes', 'connectorId', 'resourceId'], label)
  assertId(value.id, `${label}.id`)
  assertBoundedText(value.name, `${label}.name`, 512)
  if (typeof value.kind !== 'string' || !ATTACHMENT_KINDS.has(value.kind)) throw new Error(`${label}.kind is invalid.`)
  if (typeof value.source !== 'string' || !ATTACHMENT_SOURCES.has(value.source)) throw new Error(`${label}.source is invalid.`)
  assertTimestamp(value.createdAt, `${label}.createdAt`)
  if (value.mimeType !== undefined && (typeof value.mimeType !== 'string' || value.mimeType.length > 255 || !MIME_TYPE_PATTERN.test(value.mimeType))) {
    throw new Error(`${label}.mimeType is invalid.`)
  }
  if (value.sizeBytes !== undefined && (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0 || Number(value.sizeBytes) > 1024 ** 4)) {
    throw new Error(`${label}.sizeBytes is invalid.`)
  }
  if (value.connectorId !== undefined) assertId(value.connectorId, `${label}.connectorId`)
  if (value.resourceId !== undefined) assertBoundedText(value.resourceId, `${label}.resourceId`, 2_048)
  if (value.source === 'connected-app' && !value.connectorId) throw new Error(`${label} requires a connectorId for a connected-app source.`)
  if (value.kind === 'connected-resource' && !value.resourceId) throw new Error(`${label} requires a resourceId for a connected resource.`)
}

function validateToolPreview(value: unknown, label: string): asserts value is WorkToolPreview {
  if (!isRecord(value)) throw new Error(`${label} must be a preview object.`)
  assertAllowedKeys(value, ['kind', 'label', 'items', 'count', 'truncated'], label)
  if (typeof value.kind !== 'string' || !TOOL_PREVIEW_KINDS.has(value.kind)) throw new Error(`${label}.kind is invalid.`)
  assertBoundedText(value.label, `${label}.label`, 120)
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 4) throw new Error(`${label}.items must contain one to four entries.`)
  value.items.forEach((item, index) => {
    const itemLabel = `${label}.items[${index}]`
    if (!isRecord(item)) throw new Error(`${itemLabel} must be an object.`)
    assertAllowedKeys(item, ['title', 'subtitle', 'detail', 'metadata'], itemLabel)
    assertBoundedText(item.title, `${itemLabel}.title`, 300)
    if (item.subtitle !== undefined) assertBoundedText(item.subtitle, `${itemLabel}.subtitle`, 400, true)
    if (item.detail !== undefined) assertBoundedText(item.detail, `${itemLabel}.detail`, 400, true)
    if (item.metadata !== undefined) assertBoundedText(item.metadata, `${itemLabel}.metadata`, 200, true)
  })
  if (value.count !== undefined && (!Number.isSafeInteger(value.count) || Number(value.count) < 0 || Number(value.count) > 10_000)) {
    throw new Error(`${label}.count is invalid.`)
  }
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') throw new Error(`${label}.truncated is invalid.`)
}

function validateToolActivity(value: unknown, label: string): asserts value is WorkToolActivity {
  if (!isRecord(value)) throw new Error(`${label} must be a tool activity object.`)
  assertAllowedKeys(value, ['id', 'toolId', 'name', 'status', 'createdAt', 'connectorId', 'summary', 'preview', 'completedAt', 'errorCode'], label)
  assertId(value.id, `${label}.id`)
  if (typeof value.toolId !== 'string' || (!TOOL_ID_PATTERN.test(value.toolId) && !ID_PATTERN.test(value.toolId))) throw new Error(`${label}.toolId is invalid.`)
  assertBoundedText(value.name, `${label}.name`, 160)
  if (typeof value.status !== 'string' || !TOOL_STATUSES.has(value.status)) throw new Error(`${label}.status is invalid.`)
  assertTimestamp(value.createdAt, `${label}.createdAt`)
  if (value.connectorId !== undefined) assertId(value.connectorId, `${label}.connectorId`)
  if (value.summary !== undefined) assertBoundedText(value.summary, `${label}.summary`, 2_000, true)
  if (value.preview !== undefined) validateToolPreview(value.preview, `${label}.preview`)
  if (value.completedAt !== undefined) {
    assertTimestamp(value.completedAt, `${label}.completedAt`)
    if (value.completedAt < value.createdAt) throw new Error(`${label}.completedAt cannot precede its creation time.`)
  }
  if (value.errorCode !== undefined) assertBoundedText(value.errorCode, `${label}.errorCode`, 80)
}

function validateMessage(value: unknown, label: string): asserts value is WorkMessage {
  if (!isRecord(value)) throw new Error(`${label} must be a message object.`)
  assertAllowedKeys(value, ['id', 'role', 'content', 'createdAt', 'status', 'attachments', 'toolActivities'], label)
  assertId(value.id, `${label}.id`)
  if (typeof value.role !== 'string' || !MESSAGE_ROLES.has(value.role)) throw new Error(`${label}.role is invalid.`)
  assertContent(value.content, `${label}.content`)
  assertTimestamp(value.createdAt, `${label}.createdAt`)
  if (value.status !== undefined && (typeof value.status !== 'string' || !MESSAGE_STATUSES.has(value.status))) throw new Error(`${label}.status is invalid.`)
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > WORK_CONVERSATION_LIMITS.attachmentsPerMessage) {
      throw new Error(`${label} has too many attachments.`)
    }
    value.attachments.forEach((attachment, index) => validateAttachment(attachment, `${label}.attachments[${index}]`))
    if (new Set(value.attachments.map((attachment) => attachment.id)).size !== value.attachments.length) throw new Error(`${label} contains duplicate attachment IDs.`)
  }
  if (value.toolActivities !== undefined) {
    if (!Array.isArray(value.toolActivities) || value.toolActivities.length > WORK_CONVERSATION_LIMITS.toolActivitiesPerMessage) {
      throw new Error(`${label} has too many tool activities.`)
    }
    value.toolActivities.forEach((activity, index) => validateToolActivity(activity, `${label}.toolActivities[${index}]`))
    if (new Set(value.toolActivities.map((activity) => activity.id)).size !== value.toolActivities.length) throw new Error(`${label} contains duplicate tool activity IDs.`)
  }
}

function validateConversation(value: unknown, label: string): asserts value is WorkConversation {
  if (!isRecord(value)) throw new Error(`${label} must be a conversation object.`)
  assertAllowedKeys(value, ['id', 'title', 'createdAt', 'updatedAt', 'pinned', 'provider', 'modelId', 'messageCount', 'messages'], label)
  assertId(value.id, `${label}.id`)
  assertBoundedText(value.title, `${label}.title`, WORK_CONVERSATION_LIMITS.titleCharacters)
  assertTimestamp(value.createdAt, `${label}.createdAt`)
  assertTimestamp(value.updatedAt, `${label}.updatedAt`)
  if (value.updatedAt < value.createdAt) throw new Error(`${label}.updatedAt cannot precede its creation time.`)
  if (typeof value.pinned !== 'boolean') throw new Error(`${label}.pinned must be true or false.`)
  if (typeof value.provider !== 'string' || !PROVIDERS.has(value.provider)) throw new Error(`${label}.provider is invalid.`)
  if (typeof value.modelId !== 'string' || (value.modelId && !MODEL_ID_PATTERN.test(value.modelId))) throw new Error(`${label}.modelId is invalid.`)
  if (!Array.isArray(value.messages) || value.messages.length > WORK_CONVERSATION_LIMITS.messagesPerConversation) throw new Error(`${label} has too many messages.`)
  value.messages.forEach((message, index) => validateMessage(message, `${label}.messages[${index}]`))
  if (new Set(value.messages.map((message) => message.id)).size !== value.messages.length) throw new Error(`${label} contains duplicate message IDs.`)
  if (value.messageCount !== value.messages.length) throw new Error(`${label}.messageCount does not match its messages.`)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > WORK_CONVERSATION_LIMITS.conversationBytes) throw new Error(`${label} is too large.`)
}

function validateStore(value: unknown): WorkConversationStore {
  if (!isRecord(value)) throw new Error('The Work conversation store must be an object.')
  assertAllowedKeys(value, ['version', 'conversations'], 'The Work conversation store')
  if (value.version !== STORE_VERSION) throw new Error('The Work conversation store has an unsupported version.')
  if (!Array.isArray(value.conversations) || value.conversations.length > WORK_CONVERSATION_LIMITS.conversations) {
    throw new Error('The Work conversation store has too many conversations.')
  }
  value.conversations.forEach((conversation, index) => validateConversation(conversation, `conversations[${index}]`))
  if (new Set(value.conversations.map((conversation) => conversation.id)).size !== value.conversations.length) {
    throw new Error('The Work conversation store contains duplicate conversation IDs.')
  }
  return value as unknown as WorkConversationStore
}

function summary(conversation: WorkConversation): WorkConversationSummary {
  const { messages: _messages, ...value } = conversation
  return structuredClone(value)
}

function validateCreateRequest(value: unknown): CreateWorkConversationRequest {
  if (!isRecord(value)) throw new Error('Conversation creation options must be an object.')
  assertAllowedKeys(value, ['title', 'provider', 'modelId'], 'Conversation creation options')
  if (value.title !== undefined) assertBoundedText(value.title, 'title', WORK_CONVERSATION_LIMITS.titleCharacters)
  if (value.provider !== undefined && (typeof value.provider !== 'string' || !PROVIDERS.has(value.provider))) throw new Error('provider is invalid.')
  if (value.modelId !== undefined && (typeof value.modelId !== 'string' || (value.modelId && !MODEL_ID_PATTERN.test(value.modelId)))) throw new Error('modelId is invalid.')
  return value as CreateWorkConversationRequest
}

function validateUpdateRequest(value: unknown): UpdateWorkConversationRequest {
  if (!isRecord(value)) throw new Error('Conversation updates must be an object.')
  assertAllowedKeys(value, ['title', 'pinned', 'provider', 'modelId'], 'Conversation updates')
  if (value.title !== undefined) assertBoundedText(value.title, 'title', WORK_CONVERSATION_LIMITS.titleCharacters)
  if (value.pinned !== undefined && typeof value.pinned !== 'boolean') throw new Error('pinned must be true or false.')
  if (value.provider !== undefined && (typeof value.provider !== 'string' || !PROVIDERS.has(value.provider))) throw new Error('provider is invalid.')
  if (value.modelId !== undefined && (typeof value.modelId !== 'string' || (value.modelId && !MODEL_ID_PATTERN.test(value.modelId)))) throw new Error('modelId is invalid.')
  return value as UpdateWorkConversationRequest
}

function validateCreateMessageRequest(value: unknown): CreateWorkMessageRequest {
  if (!isRecord(value)) throw new Error('Message creation options must be an object.')
  assertAllowedKeys(value, ['role', 'content', 'status', 'attachments', 'toolActivities'], 'Message creation options')
  const draft = { id: 'validation', createdAt: 0, ...value }
  validateMessage(draft, 'message')
  return value as unknown as CreateWorkMessageRequest
}

function validateUpdateMessageRequest(value: unknown): UpdateWorkMessageRequest {
  if (!isRecord(value)) throw new Error('Message updates must be an object.')
  assertAllowedKeys(value, ['content', 'status', 'attachments', 'toolActivities'], 'Message updates')
  if (value.content !== undefined) assertContent(value.content, 'message.content')
  if (value.status !== undefined && (typeof value.status !== 'string' || !MESSAGE_STATUSES.has(value.status))) throw new Error('message.status is invalid.')
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > WORK_CONVERSATION_LIMITS.attachmentsPerMessage) throw new Error('The message has too many attachments.')
    value.attachments.forEach((attachment, index) => validateAttachment(attachment, `message.attachments[${index}]`))
  }
  if (value.toolActivities !== undefined) {
    if (!Array.isArray(value.toolActivities) || value.toolActivities.length > WORK_CONVERSATION_LIMITS.toolActivitiesPerMessage) throw new Error('The message has too many tool activities.')
    value.toolActivities.forEach((activity, index) => validateToolActivity(activity, `message.toolActivities[${index}]`))
  }
  return value as UpdateWorkMessageRequest
}

export class WorkConversationManager {
  private readonly storagePath: string
  private readonly now: () => number
  private readonly createId: () => string
  private queue: Promise<void> = Promise.resolve()

  constructor(storagePath: string, options: WorkConversationManagerOptions = {}) {
    if (!path.isAbsolute(storagePath)) throw new Error('Work conversation storage requires an absolute file path.')
    this.storagePath = storagePath
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  async list(): Promise<WorkConversationSummary[]> {
    await this.queue
    const store = await this.readStore()
    return this.sorted(store.conversations).map(summary)
  }

  async search(request: WorkConversationSearchRequest = {}): Promise<WorkConversationSummary[]> {
    if (!isRecord(request)) throw new Error('Conversation search options must be an object.')
    assertAllowedKeys(request, ['query', 'limit'], 'Conversation search options')
    const query = request.query ?? ''
    if (typeof query !== 'string' || query.length > WORK_CONVERSATION_LIMITS.searchCharacters || query.includes('\0')) throw new Error('The conversation search query is invalid or too long.')
    const limit = request.limit ?? 50
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > WORK_CONVERSATION_LIMITS.searchResults) throw new Error(`Search limit must be between 1 and ${WORK_CONVERSATION_LIMITS.searchResults}.`)
    await this.queue
    const store = await this.readStore()
    const needle = query.trim().toLocaleLowerCase()
    return this.sorted(store.conversations)
      .filter((conversation) => !needle || conversation.title.toLocaleLowerCase().includes(needle) || conversation.messages.some((message) => message.content.toLocaleLowerCase().includes(needle)))
      .slice(0, limit)
      .map(summary)
  }

  async get(id: string): Promise<WorkConversation> {
    assertId(id, 'Conversation ID')
    await this.queue
    const conversation = (await this.readStore()).conversations.find((item) => item.id === id)
    if (!conversation) throw new Error('Work conversation was not found.')
    return structuredClone(conversation)
  }

  create(request: CreateWorkConversationRequest = {}): Promise<WorkConversation> {
    const validated = validateCreateRequest(request)
    return this.mutate((store) => {
      if (store.conversations.length >= WORK_CONVERSATION_LIMITS.conversations) throw new Error('The Work conversation limit has been reached.')
      const id = this.nextUniqueId(store.conversations.map((conversation) => conversation.id), 'conversation')
      const timestamp = this.timestamp()
      const conversation: WorkConversation = {
        id,
        title: validated.title?.trim() ?? 'New chat',
        createdAt: timestamp,
        updatedAt: timestamp,
        pinned: false,
        provider: validated.provider ?? 'ollama',
        modelId: validated.modelId ?? '',
        messageCount: 0,
        messages: []
      }
      store.conversations.push(conversation)
      return structuredClone(conversation)
    })
  }

  update(id: string, request: UpdateWorkConversationRequest): Promise<WorkConversation> {
    assertId(id, 'Conversation ID')
    const validated = validateUpdateRequest(request)
    return this.mutate((store) => {
      const conversation = this.requireConversation(store, id)
      if (validated.title !== undefined) conversation.title = validated.title.trim()
      if (validated.pinned !== undefined) conversation.pinned = validated.pinned
      if (validated.provider !== undefined) conversation.provider = validated.provider
      if (validated.modelId !== undefined) conversation.modelId = validated.modelId
      conversation.updatedAt = this.nextUpdatedAt(conversation.updatedAt)
      return structuredClone(conversation)
    })
  }

  rename(id: string, title: string): Promise<WorkConversation> {
    return this.update(id, { title })
  }

  setPinned(id: string, pinned: boolean): Promise<WorkConversation> {
    return this.update(id, { pinned })
  }

  setModel(id: string, provider: WorkConversation['provider'], modelId: string): Promise<WorkConversation> {
    if (!modelId) throw new Error('Choose a model before updating the conversation.')
    return this.update(id, { provider, modelId })
  }

  addMessage(id: string, request: CreateWorkMessageRequest): Promise<WorkMessage> {
    assertId(id, 'Conversation ID')
    const validated = validateCreateMessageRequest(request)
    return this.mutate((store) => {
      const conversation = this.requireConversation(store, id)
      if (conversation.messages.length >= WORK_CONVERSATION_LIMITS.messagesPerConversation) throw new Error('The conversation message limit has been reached.')
      const message: WorkMessage = {
        id: this.nextUniqueId(conversation.messages.map((item) => item.id), 'message'),
        role: validated.role,
        content: validated.content,
        createdAt: this.timestamp(),
        ...(validated.status === undefined ? {} : { status: validated.status }),
        ...(validated.attachments === undefined ? {} : { attachments: structuredClone(validated.attachments) }),
        ...(validated.toolActivities === undefined ? {} : { toolActivities: structuredClone(validated.toolActivities) })
      }
      validateMessage(message, 'message')
      conversation.messages.push(message)
      conversation.messageCount = conversation.messages.length
      conversation.updatedAt = this.nextUpdatedAt(conversation.updatedAt)
      return structuredClone(message)
    })
  }

  updateMessage(conversationId: string, messageId: string, request: UpdateWorkMessageRequest): Promise<WorkMessage> {
    assertId(conversationId, 'Conversation ID')
    assertId(messageId, 'Message ID')
    const validated = validateUpdateMessageRequest(request)
    return this.mutate((store) => {
      const conversation = this.requireConversation(store, conversationId)
      const message = conversation.messages.find((item) => item.id === messageId)
      if (!message) throw new Error('Work conversation message was not found.')
      if (validated.content !== undefined) message.content = validated.content
      if (validated.status !== undefined) message.status = validated.status
      if (validated.attachments !== undefined) message.attachments = structuredClone(validated.attachments)
      if (validated.toolActivities !== undefined) message.toolActivities = structuredClone(validated.toolActivities)
      validateMessage(message, 'message')
      conversation.updatedAt = this.nextUpdatedAt(conversation.updatedAt)
      return structuredClone(message)
    })
  }

  deleteMessage(conversationId: string, messageId: string): Promise<WorkConversation> {
    assertId(conversationId, 'Conversation ID')
    assertId(messageId, 'Message ID')
    return this.mutate((store) => {
      const conversation = this.requireConversation(store, conversationId)
      const index = conversation.messages.findIndex((message) => message.id === messageId)
      if (index < 0) throw new Error('Work conversation message was not found.')
      conversation.messages.splice(index, 1)
      conversation.messageCount = conversation.messages.length
      conversation.updatedAt = this.nextUpdatedAt(conversation.updatedAt)
      return structuredClone(conversation)
    })
  }

  clearMessages(id: string): Promise<WorkConversation> {
    assertId(id, 'Conversation ID')
    return this.mutate((store) => {
      const conversation = this.requireConversation(store, id)
      conversation.messages = []
      conversation.messageCount = 0
      conversation.updatedAt = this.nextUpdatedAt(conversation.updatedAt)
      return structuredClone(conversation)
    })
  }

  delete(id: string): Promise<void> {
    assertId(id, 'Conversation ID')
    return this.mutate((store) => {
      const index = store.conversations.findIndex((conversation) => conversation.id === id)
      if (index < 0) throw new Error('Work conversation was not found.')
      store.conversations.splice(index, 1)
    })
  }

  recoverCorruptStore(): Promise<RecoverWorkConversationStoreResult> {
    return this.enqueue(async () => {
      try {
        await this.readStore()
        return { recovered: false }
      } catch (error) {
        if (!(error instanceof WorkConversationStoreCorruptError)) throw error
      }
      await this.assertRegularStorageFile()
      const backupPath = `${this.storagePath}.corrupt-${this.timestamp()}-${randomUUID()}`
      await fs.rename(this.storagePath, backupPath)
      await fs.chmod(backupPath, 0o600)
      await this.writeStore({ version: STORE_VERSION, conversations: [] })
      return { recovered: true, backupPath }
    })
  }

  private sorted(conversations: WorkConversation[]): WorkConversation[] {
    return [...conversations].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('The system clock returned an invalid timestamp.')
    return value
  }

  private nextUpdatedAt(previous: number): number {
    return Math.max(previous + 1, this.timestamp())
  }

  private nextUniqueId(existing: string[], label: string): string {
    const id = this.createId()
    assertId(id, `${label} ID`)
    if (existing.includes(id)) throw new Error(`Generated a duplicate ${label} ID.`)
    return id
  }

  private requireConversation(store: WorkConversationStore, id: string): WorkConversation {
    const conversation = store.conversations.find((item) => item.id === id)
    if (!conversation) throw new Error('Work conversation was not found.')
    return conversation
  }

  private mutate<T>(operation: (store: WorkConversationStore) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const store = await this.readStore()
      const result = await operation(store)
      validateStore(store)
      await this.writeStore(store)
      return result
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async readStore(): Promise<WorkConversationStore> {
    try {
      const status = await fs.lstat(this.storagePath)
      if (status.isSymbolicLink() || !status.isFile()) throw new Error('The Work conversation store path is not a regular file.')
      if (status.size > WORK_CONVERSATION_LIMITS.storeBytes) throw new Error('The Work conversation store is too large.')
      const parsed = JSON.parse(await fs.readFile(this.storagePath, 'utf8')) as unknown
      return validateStore(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: STORE_VERSION, conversations: [] }
      if (error instanceof WorkConversationStoreCorruptError) throw error
      throw new WorkConversationStoreCorruptError(`Work conversation history is invalid and was left untouched: ${error instanceof Error ? error.message : String(error)}`, error)
    }
  }

  private async assertRegularStorageFile(): Promise<void> {
    const status = await fs.lstat(this.storagePath)
    if (status.isSymbolicLink() || !status.isFile()) throw new Error('The Work conversation store path is not a regular file.')
  }

  private async writeStore(store: WorkConversationStore): Promise<void> {
    validateStore(store)
    const serialized = `${JSON.stringify(store, null, 2)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > WORK_CONVERSATION_LIMITS.storeBytes) throw new Error('The Work conversation store is too large.')
    const directory = path.dirname(this.storagePath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `.${path.basename(this.storagePath)}.${randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
        await handle.chmod(0o600)
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, this.storagePath)
      await fs.chmod(this.storagePath, 0o600)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export { validateStore as validateWorkConversationStore }
