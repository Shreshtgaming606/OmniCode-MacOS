import { randomUUID } from 'node:crypto'

import type { JsonValue } from '../../shared/tool-contracts'
import { GoogleOAuthManager, GOOGLE_GMAIL_SCOPES } from '../services/google-oauth-manager'
import { ToolRegistry } from '../services/tool-registry'
import { WorkTransferStore, type SaveWorkTransfer } from '../services/work-transfer-store'
import type { ConnectorAdapter } from '../services/connector-manager'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_BODY_BYTES = 128 * 1024
const MAX_THREAD_MESSAGES = 20
const MAX_ATTACHMENT_TEXT_BYTES = 128 * 1024
const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u
const SAFE_TEXT_ATTACHMENT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/rtf',
  'application/sql',
  'application/xml',
  'application/x-httpd-php',
  'application/x-sh',
  'application/yaml'
])

interface GmailPayload {
  mimeType?: unknown
  filename?: unknown
  headers?: unknown
  body?: unknown
  parts?: unknown
}

interface GmailMessageResource {
  id?: unknown
  threadId?: unknown
  labelIds?: unknown
  snippet?: unknown
  internalDate?: unknown
  payload?: unknown
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !MESSAGE_ID_PATTERN.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').trim().slice(0, maximum)
    : ''
}

function decodeBase64Url(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum * 2) return ''
  try { return Buffer.from(value, 'base64url').toString('utf8').slice(0, maximum) } catch { return '' }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' }
  return value.replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]{2,12});/giu, (match, entity: string) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ' '
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function htmlToText(value: string, maximum: number): string {
  return decodeHtmlEntities(value
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<\s*br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/giu, '\n')
    .replace(/<[^>]{0,2000}>/gu, ' '))
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, maximum)
}

function headersFromPayload(payload: GmailPayload): Record<string, string> {
  if (!Array.isArray(payload.headers)) return {}
  const result: Record<string, string> = {}
  for (const header of payload.headers) {
    if (!header || typeof header !== 'object' || Array.isArray(header)) continue
    const candidate = header as { name?: unknown; value?: unknown }
    const name = cleanText(candidate.name, 100).toLowerCase()
    if (!['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'in-reply-to', 'references'].includes(name)) continue
    result[name] = cleanText(candidate.value, 4_096)
  }
  return result
}

function bodyData(payload: GmailPayload): unknown {
  return payload.body && typeof payload.body === 'object' && !Array.isArray(payload.body)
    ? (payload.body as { data?: unknown }).data
    : undefined
}

function collectMimeText(payload: GmailPayload, targetMimeType: string, remaining: number): string {
  if (remaining <= 0) return ''
  const mimeType = cleanText(payload.mimeType, 200).toLowerCase()
  if (mimeType === targetMimeType) return decodeBase64Url(bodyData(payload), remaining)
  if (!Array.isArray(payload.parts)) return ''
  const parts: string[] = []
  let used = 0
  for (const part of payload.parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const text = collectMimeText(part as GmailPayload, targetMimeType, remaining - used)
    if (!text) continue
    parts.push(text)
    used += text.length
    if (used >= remaining) break
  }
  return parts.join('\n\n').slice(0, remaining)
}

function collectPlainText(payload: GmailPayload, remaining = MAX_BODY_BYTES): string {
  const plain = collectMimeText(payload, 'text/plain', remaining)
  if (plain) return plain
  return htmlToText(collectMimeText(payload, 'text/html', remaining * 2), remaining)
}

function collectAttachments(payload: GmailPayload): Array<Record<string, JsonValue>> {
  const results: Array<Record<string, JsonValue>> = []
  const visit = (part: GmailPayload): void => {
    const filename = cleanText(part.filename, 500)
    const body = part.body && typeof part.body === 'object' && !Array.isArray(part.body)
      ? part.body as { attachmentId?: unknown; size?: unknown }
      : undefined
    if (filename && typeof body?.attachmentId === 'string' && MESSAGE_ID_PATTERN.test(body.attachmentId)) {
      results.push({
        id: body.attachmentId,
        filename,
        mimeType: cleanText(part.mimeType, 200) || 'application/octet-stream',
        sizeBytes: Number.isSafeInteger(body.size) && Number(body.size) >= 0 ? Number(body.size) : 0
      })
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) if (child && typeof child === 'object' && !Array.isArray(child)) visit(child as GmailPayload)
    }
  }
  visit(payload)
  return results.slice(0, 100)
}

function isSafeTextAttachmentType(value: unknown): boolean {
  const mimeType = cleanText(value, 200).toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return mimeType.startsWith('text/') || SAFE_TEXT_ATTACHMENT_TYPES.has(mimeType) || mimeType.endsWith('+json') || mimeType.endsWith('+xml')
}

function normalizeMessage(value: unknown, bodyLimit = MAX_BODY_BYTES): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gmail returned an invalid message.')
  const message = value as GmailMessageResource
  const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
    ? message.payload as GmailPayload
    : {}
  const headers = headersFromPayload(payload)
  return {
    id: requireId(message.id, 'Gmail message ID'),
    threadId: requireId(message.threadId, 'Gmail thread ID'),
    from: cleanText(headers.from, 1_000),
    to: cleanText(headers.to, 1_000),
    subject: cleanText(headers.subject, 998),
    date: cleanText(headers.date, 200),
    messageId: cleanText(headers['message-id'], 998),
    snippet: cleanText(message.snippet, 1_000),
    body: collectPlainText(payload, bodyLimit),
    labels: Array.isArray(message.labelIds) ? message.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 100) : [],
    attachments: collectAttachments(payload),
    untrustedContent: true
  }
}

function cleanHeader(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\r\n\0]/u.test(normalized)) throw new Error(`${label} is invalid.`)
  return normalized
}

function recipients(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error('At least one recipient is required.')
  return value.map((entry) => cleanHeader(entry, 'Recipient', 320))
}

function transferIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10 || value.some((id) => typeof id !== 'string')) {
    throw new Error('Email attachments are invalid or exceed the 10-file limit.')
  }
  return [...new Set(value as string[])]
}

function encodedFilename(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function wrappedBase64(data: Buffer): string {
  return data.toString('base64').match(/.{1,76}/gu)?.join('\r\n') ?? ''
}

async function mimeMessage(
  input: Record<string, JsonValue>,
  reply = false,
  transfers?: WorkTransferStore
): Promise<string> {
  const to = recipients(input.to)
  const cc = input.cc === undefined ? [] : recipients(input.cc)
  const subject = cleanHeader(input.subject, 'Subject', 998)
  const body = typeof input.body === 'string' ? input.body : ''
  if (!body.trim() || Buffer.byteLength(body, 'utf8') > 128 * 1024 || body.includes('\0')) throw new Error('Email body is empty or too large.')
  const ids = transferIds(input.transferIds)
  if (ids.length && !transfers) throw new Error('Connected-app attachment transfers are unavailable.')
  const attachments = await Promise.all(ids.map((id) => transfers!.get(id)))
  if (attachments.reduce((sum, attachment) => sum + attachment.data.byteLength, 0) > MAX_EMAIL_ATTACHMENT_BYTES) {
    throw new Error('Email attachments exceed OmniCode\'s safe 18 MB combined limit.')
  }
  const envelope = [
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${subject}`
  ]
  if (reply) {
    const inReplyTo = cleanHeader(input.inReplyTo, 'Reply message ID', 998)
    envelope.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`)
  }
  if (!attachments.length) {
    envelope.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body)
    return Buffer.from(envelope.join('\r\n'), 'utf8').toString('base64url')
  }
  const boundary = `omnicode_${randomUUID().replaceAll('-', '')}`
  envelope.push(
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body
  )
  for (const attachment of attachments) {
    const filename = encodedFilename(attachment.record.filename)
    envelope.push(
      `--${boundary}`,
      `Content-Type: ${attachment.record.mimeType}; name*=UTF-8''${filename}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename*=UTF-8''${filename}`,
      '',
      wrappedBase64(attachment.data)
    )
  }
  envelope.push(`--${boundary}--`, '')
  return Buffer.from(envelope.join('\r\n'), 'utf8').toString('base64url')
}

function gmailError(status: number): Error {
  if (status === 401) return new Error('Gmail authorization expired. Reconnect the Google account.')
  if (status === 403) return new Error('Gmail denied the operation or the required permission is missing.')
  if (status === 404) return new Error('The requested Gmail item was not found.')
  if (status === 429) return new Error('Gmail rate limited the request. Try again later.')
  return new Error(status >= 500 ? 'Gmail is temporarily unavailable.' : `Gmail request failed (HTTP ${status}).`)
}

export class GmailConnector implements ConnectorAdapter {
  readonly descriptor = {
    id: 'gmail',
    name: 'Gmail',
    description: 'Search, read, organize, draft, and send mail through your Google account.',
    capabilities: ['Search and read mail', 'Read threads and text attachments', 'Manage labels and read state', 'Create drafts', 'Send only after confirmation'],
    requestedScopes: [...GOOGLE_GMAIL_SCOPES],
    accessLevel: 'ask-before-changes' as const
  }

  constructor(
    private readonly oauth: GoogleOAuthManager,
    private readonly fetchApi: typeof fetch = fetch,
    private readonly transfers?: WorkTransferStore,
    private readonly saveTransfer?: SaveWorkTransfer
  ) {}

  async connect(): Promise<void> { await this.oauth.connect('gmail') }

  async verify() {
    const status = await this.oauth.verify('gmail')
    return { connectorId: this.descriptor.id, state: status.state, message: status.message, checkedAt: status.checkedAt, grantedScopes: status.grantedScopes }
  }

  async disconnect(): Promise<void> { await this.oauth.disconnect() }

  async search(query: string, maximum: number, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    const params = new URLSearchParams({ q: query, maxResults: String(maximum) })
    const listing = await this.#json(`${GMAIL_API}/messages?${params}`, {}, signal) as { messages?: unknown; nextPageToken?: unknown; resultSizeEstimate?: unknown }
    const references = Array.isArray(listing.messages) ? listing.messages.slice(0, maximum) : []
    const messages = await Promise.all(references.map(async (reference) => {
      const id = requireId(reference && typeof reference === 'object' ? (reference as { id?: unknown }).id : undefined, 'Gmail message ID')
      const metadata = await this.#json(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, {}, signal)
      const normalized = normalizeMessage(metadata)
      delete normalized.body
      return normalized
    }))
    return {
      messages,
      resultSizeEstimate: Number.isSafeInteger(listing.resultSizeEstimate) ? Number(listing.resultSizeEstimate) : messages.length,
      nextPageToken: cleanText(listing.nextPageToken, 2_048),
      untrustedContent: true
    }
  }

  async readMessage(id: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    return normalizeMessage(await this.#json(`${GMAIL_API}/messages/${encodeURIComponent(requireId(id, 'Gmail message ID'))}?format=full`, {}, signal))
  }

  async readThread(id: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    const thread = await this.#json(`${GMAIL_API}/threads/${encodeURIComponent(requireId(id, 'Gmail thread ID'))}?format=full`, {}, signal) as { id?: unknown; messages?: unknown }
    if (!Array.isArray(thread.messages)) throw new Error('Gmail returned an invalid thread.')
    let remaining = MAX_BODY_BYTES
    const messages = thread.messages.slice(0, MAX_THREAD_MESSAGES).map((message) => {
      const normalized = normalizeMessage(message, remaining)
      remaining = Math.max(0, remaining - Buffer.byteLength(String(normalized.body), 'utf8'))
      return normalized
    })
    return {
      id: requireId(thread.id, 'Gmail thread ID'),
      messages,
      truncated: thread.messages.length > MAX_THREAD_MESSAGES || remaining === 0,
      untrustedContent: true
    }
  }

  async readAttachment(messageId: string, attachmentId: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    const checkedMessageId = requireId(messageId, 'Gmail message ID')
    const checkedAttachmentId = requireId(attachmentId, 'Gmail attachment ID')
    const message = await this.readMessage(checkedMessageId, signal)
    const attachments = Array.isArray(message.attachments) ? message.attachments : []
    const attachment = attachments.find((candidate) => (
      candidate !== null
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && candidate.id === checkedAttachmentId
    )) as Record<string, JsonValue> | undefined
    if (!attachment) throw new Error('The requested attachment is not present on this Gmail message.')
    if (!isSafeTextAttachmentType(attachment.mimeType)) {
      throw new Error('This Gmail attachment is binary or uses an unsupported text format, so OmniCode will not send its bytes to AI.')
    }
    const value = await this.#json(`${GMAIL_API}/messages/${encodeURIComponent(checkedMessageId)}/attachments/${encodeURIComponent(checkedAttachmentId)}`, {}, signal) as { data?: unknown; size?: unknown }
    const text = decodeBase64Url(value.data, MAX_ATTACHMENT_TEXT_BYTES)
    return {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      text,
      truncated: typeof value.data === 'string' && value.data.length > MAX_ATTACHMENT_TEXT_BYTES * 2,
      sizeBytes: Number.isSafeInteger(value.size) ? Number(value.size) : Buffer.byteLength(text, 'utf8'),
      untrustedContent: true
    }
  }

  async downloadAttachment(messageId: string, attachmentId: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    if (!this.transfers) throw new Error('Connected-app attachment transfers are unavailable.')
    const checkedMessageId = requireId(messageId, 'Gmail message ID')
    const checkedAttachmentId = requireId(attachmentId, 'Gmail attachment ID')
    const message = await this.readMessage(checkedMessageId, signal)
    const attachments = Array.isArray(message.attachments) ? message.attachments : []
    const attachment = attachments.find((candidate) => (
      candidate !== null
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && candidate.id === checkedAttachmentId
    )) as Record<string, JsonValue> | undefined
    if (!attachment || typeof attachment.filename !== 'string' || typeof attachment.mimeType !== 'string') {
      throw new Error('The requested attachment is not present on this Gmail message.')
    }
    const value = await this.#json(`${GMAIL_API}/messages/${encodeURIComponent(checkedMessageId)}/attachments/${encodeURIComponent(checkedAttachmentId)}`, {}, signal) as { data?: unknown; size?: unknown }
    if (typeof value.data !== 'string' || value.data.length > MAX_EMAIL_ATTACHMENT_BYTES * 2) {
      throw new Error('The Gmail attachment is missing or exceeds OmniCode\'s safe transfer limit.')
    }
    const data = Buffer.from(value.data, 'base64url')
    if (!data.byteLength || data.byteLength > MAX_EMAIL_ATTACHMENT_BYTES) throw new Error('The Gmail attachment is empty or too large to transfer.')
    return this.transfers.put({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      data,
      source: 'gmail'
    })
  }

  async saveAttachment(messageId: string, attachmentId: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    if (!this.saveTransfer) throw new Error('Saving connected-app files is unavailable.')
    const transfer = await this.downloadAttachment(messageId, attachmentId, signal)
    return this.saveTransfer(String(transfer.id))
  }

  async labels(signal?: AbortSignal): Promise<JsonValue> {
    const value = await this.#json(`${GMAIL_API}/labels`, {}, signal) as { labels?: unknown }
    if (!Array.isArray(value.labels)) throw new Error('Gmail returned an invalid label list.')
    return value.labels.slice(0, 500).flatMap((label) => {
      if (!label || typeof label !== 'object' || Array.isArray(label)) return []
      const candidate = label as { id?: unknown; name?: unknown; type?: unknown }
      if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return []
      return [{ id: candidate.id.slice(0, 256), name: candidate.name.slice(0, 500), type: cleanText(candidate.type, 100) }]
    })
  }

  async createDraft(input: Record<string, JsonValue>, signal?: AbortSignal): Promise<JsonValue> {
    const value = await this.#json(`${GMAIL_API}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw: await mimeMessage(input, false, this.transfers) } }) }, signal) as { id?: unknown; message?: { id?: unknown; threadId?: unknown } }
    return { id: requireId(value.id, 'Gmail draft ID'), messageId: requireId(value.message?.id, 'Gmail message ID'), threadId: requireId(value.message?.threadId, 'Gmail thread ID') }
  }

  async send(input: Record<string, JsonValue>, reply = false, signal?: AbortSignal): Promise<JsonValue> {
    const threadId = reply ? requireId(input.threadId, 'Gmail thread ID') : undefined
    const value = await this.#json(`${GMAIL_API}/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw: await mimeMessage(input, reply, this.transfers), ...(threadId ? { threadId } : {}) })
    }, signal) as { id?: unknown; threadId?: unknown; labelIds?: unknown }
    return {
      id: requireId(value.id, 'Gmail message ID'),
      threadId: requireId(value.threadId, 'Gmail thread ID'),
      labels: Array.isArray(value.labelIds) ? value.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 100) : []
    }
  }

  async modify(id: string, addLabelIds: string[], removeLabelIds: string[], signal?: AbortSignal): Promise<JsonValue> {
    const value = await this.#json(`${GMAIL_API}/messages/${encodeURIComponent(requireId(id, 'Gmail message ID'))}/modify`, {
      method: 'POST', body: JSON.stringify({ addLabelIds, removeLabelIds })
    }, signal) as { id?: unknown; threadId?: unknown; labelIds?: unknown }
    return {
      id: requireId(value.id, 'Gmail message ID'),
      threadId: requireId(value.threadId, 'Gmail thread ID'),
      labels: Array.isArray(value.labelIds) ? value.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 100) : []
    }
  }

  registerTools(registry: ToolRegistry): void {
    const requiredScopes = [...GOOGLE_GMAIL_SCOPES]
    const base = { connectorId: 'gmail', modes: ['work'] as const, requiredScopes }
    registry.register({
      ...base, id: 'gmail.search', name: 'Search Gmail', description: 'Search the connected Gmail mailbox and return bounded message metadata.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1_000 }, maximum: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query', 'maximum'], additionalProperties: false }
    }, async (input, context) => this.search(String(input.query), Number(input.maximum), context.signal))
    registry.register({
      ...base, id: 'gmail.read', name: 'Read Gmail message', description: 'Read one Gmail message including bounded plain-text content and attachment metadata.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId'], additionalProperties: false }
    }, async (input, context) => this.readMessage(String(input.messageId), context.signal))
    registry.register({
      ...base, id: 'gmail.thread', name: 'Read Gmail thread', description: 'Read a bounded Gmail conversation thread.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { threadId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['threadId'], additionalProperties: false }
    }, async (input, context) => this.readThread(String(input.threadId), context.signal))
    registry.register({
      ...base, id: 'gmail.attachment', name: 'Read Gmail text attachment', description: 'Read bounded text from a Gmail attachment. Binary bytes are not sent to the AI.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, attachmentId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId', 'attachmentId'], additionalProperties: false }
    }, async (input, context) => this.readAttachment(String(input.messageId), String(input.attachmentId), context.signal))
    registry.register({
      ...base, id: 'gmail.download-attachment', name: 'Prepare Gmail attachment', description: 'Download a Gmail attachment into an opaque, short-lived app-private transfer for another connected app. File bytes and local paths are never sent to the AI.', action: 'read', confirmation: 'never', timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, attachmentId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId', 'attachmentId'], additionalProperties: false }
    }, async (input, context) => this.downloadAttachment(String(input.messageId), String(input.attachmentId), context.signal))
    registry.register({
      ...base, id: 'gmail.save-attachment', name: 'Save Gmail attachment to Mac', description: 'Download a Gmail attachment and ask the user to choose its local destination in the native macOS save dialog.', action: 'write', confirmation: 'always', timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, attachmentId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId', 'attachmentId'], additionalProperties: false }
    }, async (input, context) => this.saveAttachment(String(input.messageId), String(input.attachmentId), context.signal))
    registry.register({
      ...base, id: 'gmail.labels', name: 'List Gmail labels', description: 'List labels in the connected Gmail mailbox.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }, async (_input, context) => this.labels(context.signal))
    const mailFields = {
      to: { type: 'array' as const, items: { type: 'string' as const, minLength: 1, maxLength: 320 }, minItems: 1, maxItems: 50 },
      cc: { type: 'array' as const, items: { type: 'string' as const, minLength: 1, maxLength: 320 }, maxItems: 50 },
      subject: { type: 'string' as const, minLength: 1, maxLength: 998 },
      body: { type: 'string' as const, minLength: 1, maxLength: 131_072 },
      transferIds: { type: 'array' as const, items: { type: 'string' as const, minLength: 36, maxLength: 36 }, maxItems: 10 }
    }
    registry.register({
      ...base, id: 'gmail.draft', name: 'Create Gmail draft', description: 'Create a Gmail draft without sending it.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: mailFields, required: ['to', 'subject', 'body'], additionalProperties: false }
    }, async (input, context) => this.createDraft(input, context.signal))
    registry.register({
      ...base, id: 'gmail.send', name: 'Send Gmail message', description: 'Send an email with the exact recipients, subject, and body shown in confirmation.', action: 'sensitive', confirmation: 'always',
      inputSchema: { type: 'object', properties: mailFields, required: ['to', 'subject', 'body'], additionalProperties: false }
    }, async (input, context) => this.send(input, false, context.signal))
    registry.register({
      ...base, id: 'gmail.reply', name: 'Reply in Gmail', description: 'Send a reply in an existing thread after exact-content confirmation.', action: 'sensitive', confirmation: 'always',
      inputSchema: { type: 'object', properties: { ...mailFields, threadId: { type: 'string', minLength: 1, maxLength: 256 }, inReplyTo: { type: 'string', minLength: 1, maxLength: 998 } }, required: ['to', 'subject', 'body', 'threadId', 'inReplyTo'], additionalProperties: false }
    }, async (input, context) => this.send(input, true, context.signal))
    registry.register({
      ...base, id: 'gmail.read-state', name: 'Change Gmail read state', description: 'Mark a Gmail message read or unread.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, unread: { type: 'boolean' } }, required: ['messageId', 'unread'], additionalProperties: false }
    }, async (input, context) => this.modify(String(input.messageId), input.unread ? ['UNREAD'] : [], input.unread ? [] : ['UNREAD'], context.signal))
    registry.register({
      ...base, id: 'gmail.archive', name: 'Archive Gmail message', description: 'Archive a Gmail message by removing it from the inbox.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId'], additionalProperties: false }
    }, async (input, context) => this.modify(String(input.messageId), [], ['INBOX'], context.signal))
    registry.register({
      ...base, id: 'gmail.modify-labels', name: 'Change Gmail labels', description: 'Add or remove selected labels on a Gmail message.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, addLabelIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256 }, maxItems: 50 }, removeLabelIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256 }, maxItems: 50 } }, required: ['messageId', 'addLabelIds', 'removeLabelIds'], additionalProperties: false }
    }, async (input, context) => this.modify(String(input.messageId), input.addLabelIds as string[], input.removeLabelIds as string[], context.signal))
  }

  async #json(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const accessToken = await this.oauth.getAccessToken(GOOGLE_GMAIL_SCOPES)
    let response: Response
    try {
      response = await this.fetchApi(url, {
        ...init,
        signal: signal ?? init.signal,
        headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers, Authorization: `Bearer ${accessToken}` }
      })
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new Error('Gmail could not be reached. Check the network and try again.')
    }
    if (!response.ok) throw gmailError(response.status)
    return response.json()
  }
}
