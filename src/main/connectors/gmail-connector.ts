import { randomUUID } from 'node:crypto'
import { domainToASCII } from 'node:url'

import type { JsonValue } from '../../shared/tool-contracts'
import { GoogleOAuthManager, GOOGLE_GMAIL_SCOPES } from '../services/google-oauth-manager'
import { redactDiagnosticMessage } from '../services/diagnostic-logger'
import { ToolRegistry } from '../services/tool-registry'
import { WorkTransferStore, type SaveWorkTransfer } from '../services/work-transfer-store'
import type { ConnectorAdapter } from '../services/connector-manager'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_BODY_BYTES = 128 * 1024
const MAX_THREAD_MESSAGES = 20
const MAX_ATTACHMENT_TEXT_BYTES = 128 * 1024
const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u
const RESERVED_RECIPIENT_DOMAINS = new Set(['example.com', 'example.net', 'example.org', 'localhost'])
const SELF_RECIPIENT_ALIASES = new Set([
  'self',
  'me',
  'myself',
  'my email',
  'my email address',
  'my gmail',
  'my gmail account',
  'my connected gmail account',
  'email me',
  'send this to me',
  'send this to myself',
  'send this to my email',
  'send this to my gmail',
  'send this to myself at my connected gmail account'
])
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

export interface GmailApiDiagnostic {
  operation: string
  endpoint: string
  httpStatus: number
  googleReason: string
  googleMessage: string
  requestMetadata?: {
    recipientCount: number
    hasSubject: boolean
    bodyLength: number
    hasAttachment: boolean
    mode: 'draft' | 'message' | 'reply'
  }
}

type GmailDiagnosticReporter = (diagnostic: GmailApiDiagnostic) => void | Promise<void>

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
    cc: cleanText(headers.cc, 1_000),
    bcc: cleanText(headers.bcc, 1_000),
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

function isSelfRecipient(value: string): boolean {
  return SELF_RECIPIENT_ALIASES.has(value.toLowerCase().replace(/[.!?]+$/gu, '').replace(/\s+/gu, ' ').trim())
}

function mailbox(value: unknown, label = 'Recipient'): string {
  const normalized = cleanHeader(value, label, 320)
  const displayMatch = normalized.match(/^(.+?)\s*<([^<>]+)>$/u)
  if ((normalized.includes('<') || normalized.includes('>')) && !displayMatch) throw new Error(`${label} is not a valid email address.`)
  const displayName = displayMatch?.[1].trim()
  const address = (displayMatch?.[2] ?? normalized).trim()
  const at = address.lastIndexOf('@')
  if (at <= 0 || at === address.length - 1 || address.slice(0, at).includes('@')) throw new Error(`${label} is not a valid email address.`)
  const local = address.slice(0, at)
  const domain = domainToASCII(address.slice(at + 1))
  const quotedLocal = /^"(?:[^"\\\r\n]|\\[\x20-\x7e])+"$/u.test(local)
  const dotAtom = !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    !/[\s()<>,;:\\"\[\]]/u.test(local)
  if ((!quotedLocal && !dotAtom) || Buffer.byteLength(local, 'utf8') > 64 || !domain || domain.length > 253) {
    throw new Error(`${label} is not a valid email address.`)
  }
  const labels = domain.split('.')
  if (labels.some((entry) => !entry || entry.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(entry))) {
    throw new Error(`${label} is not a valid email address.`)
  }
  const normalizedDomain = domain.toLowerCase()
  if (
    RESERVED_RECIPIENT_DOMAINS.has(normalizedDomain) ||
    [...RESERVED_RECIPIENT_DOMAINS].some((reserved) => normalizedDomain.endsWith(`.${reserved}`)) ||
    /\.(?:example|invalid|test)$/u.test(normalizedDomain)
  ) {
    throw new Error(`${label} uses a reserved placeholder domain. Use "self" for the connected Gmail account or provide a real recipient address.`)
  }
  const normalizedAddress = `${local}@${normalizedDomain}`
  if (!displayName) return normalizedAddress
  if (!displayName || /[<>]/u.test(displayName) || (/[,;]/u.test(displayName) && !/^"(?:[^"\\\r\n]|\\[\x20-\x7e])+"$/u.test(displayName))) {
    throw new Error(`${label} display name is invalid.`)
  }
  return `${displayName} <${normalizedAddress}>`
}

function recipients(value: unknown, profileEmail: string, required: boolean, label: string): string[] {
  if (!Array.isArray(value) || value.length > 50 || (required && !value.length)) throw new Error(required ? 'At least one recipient is required.' : `${label} recipients are invalid.`)
  return [...new Set(value.map((entry) => {
    const header = cleanHeader(entry, label, 320)
    return isSelfRecipient(header) ? profileEmail : mailbox(header, label)
  }))]
}

function preflightRecipients(input: Record<string, JsonValue>): void {
  for (const [value, required, label] of [
    [input.to, true, 'Recipient'],
    [input.cc, false, 'Cc recipient'],
    [input.bcc, false, 'Bcc recipient']
  ] as const) {
    if (value === undefined && !required) continue
    if (!Array.isArray(value) || value.length > 50 || (required && !value.length)) {
      throw new Error(required ? 'At least one recipient is required.' : `${label} recipients are invalid.`)
    }
    for (const entry of value) {
      const header = cleanHeader(entry, label, 320)
      if (!isSelfRecipient(header)) mailbox(header, label)
    }
  }
}

function preflightMessage(input: Record<string, JsonValue>): void {
  preflightRecipients(input)
  cleanHeader(input.subject, 'Subject', 998)
  const body = typeof input.body === 'string' ? input.body : ''
  if (!body.trim() || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES || body.includes('\0')) {
    throw new Error('Email body is empty or too large.')
  }
  transferIds(input.transferIds)
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

function encodedSubject(value: string): string {
  if (/^[\x20-\x7e]+$/u.test(value)) return value
  const chunks: string[] = []
  let current = ''
  for (const character of value) {
    const candidate = `${current}${character}`
    if (current && Buffer.byteLength(candidate, 'utf8') > 45) {
      chunks.push(current)
      current = character
    } else current = candidate
  }
  if (current) chunks.push(current)
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`).join('\r\n ')
}

function crlfBody(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, '\n').replace(/\n/gu, '\r\n')
}

async function mimeMessage(
  input: Record<string, JsonValue>,
  profileEmail: string,
  reply = false,
  transfers?: WorkTransferStore
): Promise<string> {
  const to = recipients(input.to, profileEmail, true, 'Recipient')
  const cc = input.cc === undefined ? [] : recipients(input.cc, profileEmail, false, 'Cc recipient')
  const bcc = input.bcc === undefined ? [] : recipients(input.bcc, profileEmail, false, 'Bcc recipient')
  const subject = cleanHeader(input.subject, 'Subject', 998)
  const body = crlfBody(typeof input.body === 'string' ? input.body : '')
  if (!body.trim() || Buffer.byteLength(body, 'utf8') > 128 * 1024 || body.includes('\0')) throw new Error('Email body is empty or too large.')
  const ids = transferIds(input.transferIds)
  if (ids.length && !transfers) throw new Error('Connected-app attachment transfers are unavailable.')
  const attachments = await Promise.all(ids.map((id) => transfers!.get(id)))
  if (attachments.reduce((sum, attachment) => sum + attachment.data.byteLength, 0) > MAX_EMAIL_ATTACHMENT_BYTES) {
    throw new Error('Email attachments exceed OmniCode\'s safe 18 MB combined limit.')
  }
  const envelope = [
    `From: ${profileEmail}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${encodedSubject(subject)}`
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

function gmailUserError(status: number): Error {
  if (status === 401) return new Error('Gmail authorization expired. Reconnect the Google account.')
  if (status === 403) return new Error('Gmail denied the operation or the required permission is missing.')
  if (status === 404) return new Error('The requested Gmail item was not found.')
  if (status === 429) return new Error('Gmail rate limited the request. Try again later.')
  return new Error(status >= 500 ? 'Gmail is temporarily unavailable.' : `Gmail request failed (HTTP ${status}).`)
}

function googleErrorDetails(value: unknown): { reason: string; message: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: '', message: '' }
  const outer = value as { error?: unknown }
  if (!outer.error || typeof outer.error !== 'object' || Array.isArray(outer.error)) return { reason: '', message: '' }
  const error = outer.error as { message?: unknown; errors?: unknown; details?: unknown }
  const message = error.message === undefined ? '' : redactDiagnosticMessage(cleanText(error.message, 1_000))
  const legacyReason = Array.isArray(error.errors)
    ? error.errors.flatMap((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      ? cleanText((entry as { reason?: unknown }).reason, 200) || []
      : [])[0]
    : undefined
  const detailReason = Array.isArray(error.details)
    ? error.details.flatMap((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      ? cleanText((entry as { reason?: unknown }).reason, 200) || []
      : [])[0]
    : undefined
  const reason = legacyReason ?? detailReason
  return { reason: reason ? redactDiagnosticMessage(reason) : '', message }
}

async function gmailFailure(
  response: Response,
  operation: string,
  endpoint: string,
  requestMetadata?: GmailApiDiagnostic['requestMetadata']
): Promise<{ error: Error; diagnostic: GmailApiDiagnostic }> {
  let value: unknown
  try {
    const text = (await response.text()).slice(0, 64 * 1024)
    value = text ? JSON.parse(text) : undefined
  } catch {
    value = undefined
  }
  const details = googleErrorDetails(value)
  return {
    error: gmailUserError(response.status),
    diagnostic: {
      operation,
      endpoint,
      httpStatus: response.status,
      googleReason: details.reason,
      googleMessage: details.message,
      ...(requestMetadata ? { requestMetadata } : {})
    }
  }
}

export class GmailConnector implements ConnectorAdapter {
  #profileCache?: { email: string; expiresAt: number }

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
    private readonly saveTransfer?: SaveWorkTransfer,
    private readonly reportDiagnostic?: GmailDiagnosticReporter
  ) {}

  async connect(): Promise<void> {
    this.#profileCache = undefined
    await this.oauth.connect('gmail')
  }

  async verify() {
    const status = await this.oauth.verify('gmail')
    return { connectorId: this.descriptor.id, state: status.state, message: status.message, checkedAt: status.checkedAt, grantedScopes: status.grantedScopes }
  }

  async disconnect(): Promise<void> {
    this.#profileCache = undefined
    await this.oauth.disconnect()
  }

  async resolveMessageForApproval(input: Record<string, JsonValue>, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    preflightMessage(input)
    const profileEmail = await this.#profileEmail(signal)
    return {
      ...input,
      to: recipients(input.to, profileEmail, true, 'Recipient'),
      cc: input.cc === undefined ? [] : recipients(input.cc, profileEmail, false, 'Cc recipient'),
      bcc: input.bcc === undefined ? [] : recipients(input.bcc, profileEmail, false, 'Bcc recipient')
    }
  }

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
    preflightMessage(input)
    const profileEmail = await this.#profileEmail(signal)
    const value = await this.#json(`${GMAIL_API}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw: await mimeMessage(input, profileEmail, false, this.transfers) } }) }, signal, 'gmail.draft', this.#messageMetadata(input, 'draft')) as { id?: unknown; message?: { id?: unknown; threadId?: unknown } }
    await this.#removeConsumedTransfers(input)
    return { id: requireId(value.id, 'Gmail draft ID'), messageId: requireId(value.message?.id, 'Gmail message ID'), threadId: requireId(value.message?.threadId, 'Gmail thread ID') }
  }

  async send(input: Record<string, JsonValue>, reply = false, signal?: AbortSignal): Promise<JsonValue> {
    const threadId = reply ? requireId(input.threadId, 'Gmail thread ID') : undefined
    preflightMessage(input)
    const profileEmail = await this.#profileEmail(signal)
    const value = await this.#json(`${GMAIL_API}/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw: await mimeMessage(input, profileEmail, reply, this.transfers), ...(threadId ? { threadId } : {}) })
    }, signal, reply ? 'gmail.reply' : 'gmail.send', this.#messageMetadata(input, reply ? 'reply' : 'message')) as { id?: unknown; threadId?: unknown; labelIds?: unknown }
    await this.#removeConsumedTransfers(input)
    return {
      id: requireId(value.id, 'Gmail message ID'),
      threadId: requireId(value.threadId, 'Gmail thread ID'),
      labels: Array.isArray(value.labelIds) ? value.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 100) : []
    }
  }

  async sendDraft(draftId: string, signal?: AbortSignal): Promise<JsonValue> {
    const value = await this.#json(`${GMAIL_API}/drafts/send`, {
      method: 'POST', body: JSON.stringify({ id: requireId(draftId, 'Gmail draft ID') })
    }, signal, 'gmail.send-draft') as { id?: unknown; threadId?: unknown; labelIds?: unknown }
    return {
      id: requireId(value.id, 'Gmail message ID'),
      threadId: requireId(value.threadId, 'Gmail thread ID'),
      labels: Array.isArray(value.labelIds) ? value.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 100) : []
    }
  }

  async resolveDraftForApproval(draftId: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    const checkedDraftId = requireId(draftId, 'Gmail draft ID')
    const value = await this.#json(
      `${GMAIL_API}/drafts/${encodeURIComponent(checkedDraftId)}?format=full`,
      {}, signal, 'gmail.read-draft'
    ) as { id?: unknown; message?: unknown }
    if (requireId(value.id, 'Gmail draft ID') !== checkedDraftId) throw new Error('Gmail returned the wrong draft for approval.')
    const message = normalizeMessage(value.message)
    return {
      draftId: checkedDraftId,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      body: message.body
    }
  }

  async #removeConsumedTransfers(input: Record<string, JsonValue>): Promise<void> {
    if (!this.transfers) return
    await Promise.allSettled(transferIds(input.transferIds).map((id) => this.transfers!.remove(id)))
  }

  #messageMetadata(input: Record<string, JsonValue>, mode: 'draft' | 'message' | 'reply'): GmailApiDiagnostic['requestMetadata'] {
    return {
      recipientCount: [input.to, input.cc, input.bcc].reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0),
      hasSubject: typeof input.subject === 'string' && input.subject.trim().length > 0,
      bodyLength: typeof input.body === 'string' ? input.body.length : 0,
      hasAttachment: Array.isArray(input.transferIds) && input.transferIds.length > 0,
      mode
    }
  }

  async #profileEmail(signal?: AbortSignal): Promise<string> {
    if (this.#profileCache && this.#profileCache.expiresAt > Date.now()) return this.#profileCache.email
    const value = await this.#json(`${GMAIL_API}/profile`, {}, signal, 'gmail.profile') as { emailAddress?: unknown }
    const email = mailbox(value.emailAddress, 'Authenticated Gmail address')
    this.#profileCache = { email, expiresAt: Date.now() + 5 * 60_000 }
    return email
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
    const readSafety = { category: 'read' as const, risk: 'low' as const, reversible: true, externalSideEffect: false }
    const routineWrite = { category: 'write' as const, risk: 'low' as const, reversible: true, externalSideEffect: true }
    const communication = { category: 'communication' as const, risk: 'medium' as const, reversible: false, externalSideEffect: true }
    registry.register({
      ...base, ...readSafety, id: 'gmail.search', name: 'Search Gmail', description: 'Search the connected Gmail mailbox and return bounded message metadata.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1_000 }, maximum: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query', 'maximum'], additionalProperties: false }
    }, async (input, context) => this.search(String(input.query), Number(input.maximum), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'gmail.read', name: 'Read Gmail message', description: 'Read one Gmail message including bounded plain-text content and attachment metadata.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId'], additionalProperties: false }
    }, async (input, context) => this.readMessage(String(input.messageId), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'gmail.thread', name: 'Read Gmail thread', description: 'Read a bounded Gmail conversation thread.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { threadId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['threadId'], additionalProperties: false }
    }, async (input, context) => this.readThread(String(input.threadId), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'gmail.attachment', name: 'Read Gmail text attachment', description: 'Read bounded text from a Gmail attachment. Binary bytes are not sent to the AI.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, attachmentId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId', 'attachmentId'], additionalProperties: false }
    }, async (input, context) => this.readAttachment(String(input.messageId), String(input.attachmentId), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'gmail.download-attachment', name: 'Prepare Gmail attachment', description: 'Download a Gmail attachment into an opaque, short-lived app-private transfer for another connected app. File bytes and local paths are never sent to the AI.', action: 'read', confirmation: 'never', timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, attachmentId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId', 'attachmentId'], additionalProperties: false }
    }, async (input, context) => this.downloadAttachment(String(input.messageId), String(input.attachmentId), context.signal))
    registry.register({
      ...base, ...routineWrite, risk: 'medium', id: 'gmail.save-attachment', name: 'Save Gmail attachment to Mac', description: 'Download a Gmail attachment and ask the user to choose its local destination in the native macOS save dialog.', action: 'write', confirmation: 'always', timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, attachmentId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId', 'attachmentId'], additionalProperties: false }
    }, async (input, context) => this.saveAttachment(String(input.messageId), String(input.attachmentId), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'gmail.labels', name: 'List Gmail labels', description: 'List labels in the connected Gmail mailbox.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }, async (_input, context) => this.labels(context.signal))
    const mailFields = {
      to: { type: 'array' as const, description: 'Recipients. Use "self" for the connected Gmail account; otherwise use valid email addresses.', items: { type: 'string' as const, minLength: 1, maxLength: 320 }, minItems: 1, maxItems: 50 },
      cc: { type: 'array' as const, items: { type: 'string' as const, minLength: 1, maxLength: 320 }, maxItems: 50 },
      bcc: { type: 'array' as const, items: { type: 'string' as const, minLength: 1, maxLength: 320 }, maxItems: 50 },
      subject: { type: 'string' as const, minLength: 1, maxLength: 998 },
      body: { type: 'string' as const, minLength: 1, maxLength: 131_072 },
      transferIds: { type: 'array' as const, items: { type: 'string' as const, minLength: 36, maxLength: 36 }, maxItems: 10 }
    }
    registry.register({
      ...base, ...routineWrite, id: 'gmail.draft', name: 'Create Gmail draft', description: 'Create and save an unsent Gmail draft. Use this only when the requested final state is an unsent draft. If the user asks to draft or compose and then send, use Send Gmail message instead. When the user means their connected account, use "self" in to; never invent a placeholder address.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: mailFields, required: ['to', 'subject', 'body'], additionalProperties: false }
    }, async (input, context) => this.createDraft(input, context.signal))
    registry.register({
      ...base, ...communication, id: 'gmail.send-draft', name: 'Send existing Gmail draft', description: 'Send an existing Gmail draft created earlier in this task. Use the exact draftId returned by Create Gmail draft. This requires a separate send approval.', action: 'sensitive', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { draftId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['draftId'], additionalProperties: false }
    }, async (input, context) => this.sendDraft(String(input.draftId), context.signal))
    registry.register({
      ...base, ...communication, id: 'gmail.send', name: 'Send Gmail message', description: 'Compose and send an email using the exact validated recipients, subject, and body. Use this when the user asks to draft or compose an email and then send it; do not create a separate unsent draft first. When the user means their connected account, use "self" in to; never invent a placeholder address.', action: 'sensitive', confirmation: 'policy',
      inputSchema: { type: 'object', properties: mailFields, required: ['to', 'subject', 'body'], additionalProperties: false }
    }, async (input, context) => this.send(input, false, context.signal))
    registry.register({
      ...base, ...communication, id: 'gmail.reply', name: 'Reply in Gmail', description: 'Send a reply in an existing Gmail thread.', action: 'sensitive', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { ...mailFields, threadId: { type: 'string', minLength: 1, maxLength: 256 }, inReplyTo: { type: 'string', minLength: 1, maxLength: 998 } }, required: ['to', 'subject', 'body', 'threadId', 'inReplyTo'], additionalProperties: false }
    }, async (input, context) => this.send(input, true, context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'gmail.read-state', name: 'Change Gmail read state', description: 'Mark a Gmail message read or unread.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, unread: { type: 'boolean' } }, required: ['messageId', 'unread'], additionalProperties: false }
    }, async (input, context) => this.modify(String(input.messageId), input.unread ? ['UNREAD'] : [], input.unread ? [] : ['UNREAD'], context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'gmail.archive', name: 'Archive Gmail message', description: 'Archive a Gmail message by removing it from the inbox.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['messageId'], additionalProperties: false }
    }, async (input, context) => this.modify(String(input.messageId), [], ['INBOX'], context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'gmail.modify-labels', name: 'Change Gmail labels', description: 'Add or remove selected labels on a Gmail message.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 256 }, addLabelIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256 }, maxItems: 50 }, removeLabelIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256 }, maxItems: 50 } }, required: ['messageId', 'addLabelIds', 'removeLabelIds'], additionalProperties: false }
    }, async (input, context) => this.modify(String(input.messageId), input.addLabelIds as string[], input.removeLabelIds as string[], context.signal))
  }

  async #json(
    url: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    operation = 'gmail.request',
    requestMetadata?: GmailApiDiagnostic['requestMetadata']
  ): Promise<unknown> {
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
    if (!response.ok) {
      const endpoint = (() => { try { return new URL(url).pathname } catch { return 'gmail-api' } })()
      const failure = await gmailFailure(response, operation, endpoint, requestMetadata)
      await Promise.resolve(this.reportDiagnostic?.(failure.diagnostic)).catch(() => undefined)
      throw failure.error
    }
    return response.json()
  }
}
