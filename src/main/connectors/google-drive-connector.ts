import { randomUUID } from 'node:crypto'

import type { JsonValue } from '../../shared/tool-contracts'
import type { ConnectorAdapter } from '../services/connector-manager'
import { GOOGLE_DRIVE_SCOPES, GoogleOAuthManager } from '../services/google-oauth-manager'
import { ToolRegistry } from '../services/tool-registry'
import { WorkTransferStore, type SaveWorkTransfer } from '../services/work-transfer-store'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u
const MAX_FILE_TEXT_BYTES = 256 * 1024
const MAX_TRANSFER_BYTES = 24 * 1024 * 1024
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,parents,trashed,webViewLink,description,starred'

interface DriveFileResource {
  id?: unknown
  name?: unknown
  mimeType?: unknown
  size?: unknown
  createdTime?: unknown
  modifiedTime?: unknown
  parents?: unknown
  trashed?: unknown
  webViewLink?: unknown
  description?: unknown
  starred?: unknown
}

function requireId(value: unknown, label = 'Google Drive file ID'): string {
  if (typeof value !== 'string' || !FILE_ID_PATTERN.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').trim().slice(0, maximum)
    : ''
}

function normalizeFile(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Google Drive returned invalid file metadata.')
  const file = value as DriveFileResource
  const id = requireId(file.id)
  const name = cleanText(file.name, 1_000)
  const mimeType = cleanText(file.mimeType, 300)
  if (!name || !mimeType) throw new Error('Google Drive returned incomplete file metadata.')
  return {
    id,
    name,
    mimeType,
    sizeBytes: typeof file.size === 'string' && /^\d+$/u.test(file.size) ? Math.min(Number(file.size), Number.MAX_SAFE_INTEGER) : 0,
    createdTime: cleanText(file.createdTime, 100),
    modifiedTime: cleanText(file.modifiedTime, 100),
    parents: Array.isArray(file.parents) ? file.parents.filter((parent): parent is string => typeof parent === 'string' && FILE_ID_PATTERN.test(parent)).slice(0, 100) : [],
    trashed: file.trashed === true,
    starred: file.starred === true,
    webViewLink: typeof file.webViewLink === 'string' && file.webViewLink.startsWith('https://') ? file.webViewLink.slice(0, 2_048) : '',
    description: cleanText(file.description, 4_096),
    untrustedContent: true
  }
}

function driveError(status: number): Error {
  if (status === 401) return new Error('Google Drive authorization expired. Reconnect the Google account.')
  if (status === 403) return new Error('Google Drive denied the operation or the required permission is missing.')
  if (status === 404) return new Error('The requested Google Drive item was not found.')
  if (status === 409) return new Error('Google Drive could not complete the change because the item changed.')
  if (status === 429) return new Error('Google Drive rate limited the request. Try again later.')
  return new Error(status >= 500 ? 'Google Drive is temporarily unavailable.' : `Google Drive request failed (HTTP ${status}).`)
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")
}

function textUpload(input: Record<string, JsonValue>): { name: string; mimeType: string; content: string; parentId?: string } {
  const name = cleanText(input.name, 1_000)
  const mimeType = cleanText(input.mimeType, 300)
  const content = typeof input.content === 'string' ? input.content : ''
  const parentId = input.parentId === undefined || input.parentId === '' ? undefined : requireId(input.parentId, 'Google Drive parent folder ID')
  if (!name || /[\r\n\0]/u.test(name)) throw new Error('Google Drive file name is invalid.')
  if (!/^text\/[A-Za-z0-9.+-]+(?:;\s*charset=[A-Za-z0-9_-]+)?$/u.test(mimeType) && !['application/json', 'application/xml', 'application/javascript', 'application/markdown'].includes(mimeType)) {
    throw new Error('Only bounded text files can be uploaded from an AI tool.')
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_TEXT_BYTES || content.includes('\0')) throw new Error('Google Drive upload content is too large or invalid.')
  return { name, mimeType, content, ...(parentId ? { parentId } : {}) }
}

function downloadExport(file: Record<string, JsonValue>): { mimeType: string; filename: string } | undefined {
  const mimeType = String(file.mimeType)
  const name = String(file.name)
  if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.presentation' || mimeType === 'application/vnd.google-apps.spreadsheet') {
    return { mimeType: 'application/pdf', filename: /\.pdf$/iu.test(name) ? name : `${name}.pdf` }
  }
  return undefined
}

function decodeSafeText(data: Buffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new Error('The Drive file is not valid UTF-8 text, so OmniCode will not send it to the AI.')
  }
  if (text.includes('\0')) throw new Error('The Drive file contains binary data, so OmniCode will not send it to the AI.')
  return text
}

export class GoogleDriveConnector implements ConnectorAdapter {
  readonly descriptor = {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Find, read, export, upload, and organize files in your Google Drive.',
    capabilities: ['Search and list files', 'Read and export text content', 'Create folders and upload text files', 'Rename, move, copy, trash, and restore after confirmation'],
    requestedScopes: [...GOOGLE_DRIVE_SCOPES],
    accessLevel: 'ask-before-changes' as const
  }

  constructor(
    private readonly oauth: GoogleOAuthManager,
    private readonly fetchApi: typeof fetch = fetch,
    private readonly transfers?: WorkTransferStore,
    private readonly saveTransfer?: SaveWorkTransfer
  ) {}

  async connect(): Promise<void> { await this.oauth.connect('google-drive') }

  async verify() {
    const status = await this.oauth.verify('google-drive')
    return { connectorId: this.descriptor.id, state: status.state, message: status.message, checkedAt: status.checkedAt, grantedScopes: status.grantedScopes }
  }

  async disconnect(): Promise<void> { await this.oauth.disconnect() }

  async search(query: string, maximum: number, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    const normalized = query.trim()
    if (!normalized || normalized.length > 1_000 || normalized.includes('\0')) throw new Error('Google Drive search is empty or too long.')
    return this.#list({
      q: `fullText contains '${escapeDriveQuery(normalized)}' and trashed = false`,
      pageSize: String(maximum),
      orderBy: 'modifiedTime desc'
    }, signal)
  }

  listRecent(maximum: number, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    return this.#list({ q: 'trashed = false', pageSize: String(maximum), orderBy: 'modifiedTime desc' }, signal)
  }

  listFolder(folderId: string, maximum: number, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    const id = requireId(folderId, 'Google Drive folder ID')
    return this.#list({ q: `'${id}' in parents and trashed = false`, pageSize: String(maximum), orderBy: 'folder,name_natural' }, signal)
  }

  async metadata(fileId: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    return normalizeFile(await this.#json(`${DRIVE_API}/files/${encodeURIComponent(requireId(fileId))}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {}, signal))
  }

  async readText(fileId: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    const file = await this.metadata(fileId, signal)
    const id = String(file.id)
    const mimeType = String(file.mimeType)
    let exportMimeType = ''
    if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.presentation') exportMimeType = 'text/plain'
    else if (mimeType === 'application/vnd.google-apps.spreadsheet') exportMimeType = 'text/csv'
    else if (!mimeType.startsWith('text/') && !['application/json', 'application/xml', 'application/javascript', 'application/markdown'].includes(mimeType)) {
      throw new Error('This Drive file is binary. OmniCode will not send binary bytes to the AI; download it explicitly instead.')
    }
    const url = exportMimeType
      ? `${DRIVE_API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportMimeType)}`
      : `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`
    const response = await this.#request(url, {}, signal)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_FILE_TEXT_BYTES) throw new Error('The Drive file is too large to read into Work Mode.')
    return { file, text: decodeSafeText(bytes), exportedAs: exportMimeType || mimeType, untrustedContent: true }
  }

  async createFolder(nameValue: string, parentIdValue?: string, signal?: AbortSignal): Promise<JsonValue> {
    const name = cleanText(nameValue, 1_000)
    if (!name || /[\r\n\0]/u.test(name)) throw new Error('Google Drive folder name is invalid.')
    const parentId = parentIdValue ? requireId(parentIdValue, 'Google Drive parent folder ID') : undefined
    return normalizeFile(await this.#json(`${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: 'POST',
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) })
    }, signal))
  }

  async upload(input: Record<string, JsonValue>, signal?: AbortSignal): Promise<JsonValue> {
    const upload = textUpload(input)
    return this.#multipartUpload(upload.name, upload.mimeType, Buffer.from(upload.content, 'utf8'), upload.parentId, signal)
  }

  async uploadTransfer(transferId: string, parentIdValue?: string, nameValue?: string, signal?: AbortSignal): Promise<JsonValue> {
    if (!this.transfers) throw new Error('Connected-app attachment transfers are unavailable.')
    const transfer = await this.transfers.get(transferId)
    const name = nameValue === undefined ? transfer.record.filename : cleanText(nameValue, 1_000)
    if (!name || /[\r\n\0]/u.test(name)) throw new Error('Google Drive file name is invalid.')
    const parentId = parentIdValue ? requireId(parentIdValue, 'Google Drive parent folder ID') : undefined
    return this.#multipartUpload(name, transfer.record.mimeType, transfer.data, parentId, signal)
  }

  async download(fileId: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    if (!this.transfers) throw new Error('Connected-app attachment transfers are unavailable.')
    const file = await this.metadata(fileId, signal)
    if (file.mimeType === 'application/vnd.google-apps.folder') throw new Error('Google Drive folders cannot be downloaded as files.')
    const sizeBytes = typeof file.sizeBytes === 'number' ? file.sizeBytes : 0
    if (sizeBytes > MAX_TRANSFER_BYTES) throw new Error('The Drive file exceeds OmniCode\'s safe 24 MB transfer limit.')
    const exported = downloadExport(file)
    const nativeGoogleType = String(file.mimeType).startsWith('application/vnd.google-apps.')
    if (nativeGoogleType && !exported) throw new Error('This Google Workspace file type does not have a supported transfer export.')
    const id = String(file.id)
    const url = exported
      ? `${DRIVE_API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exported.mimeType)}`
      : `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`
    const response = await this.#request(url, {}, signal)
    const contentLength = Number(response.headers.get('Content-Length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_TRANSFER_BYTES) throw new Error('The Drive file exceeds OmniCode\'s safe 24 MB transfer limit.')
    const data = Buffer.from(await response.arrayBuffer())
    if (!data.byteLength || data.byteLength > MAX_TRANSFER_BYTES) throw new Error('The Drive file is empty or too large to transfer.')
    return this.transfers.put({
      filename: exported?.filename ?? String(file.name),
      mimeType: exported?.mimeType ?? String(file.mimeType),
      data,
      source: 'google-drive'
    })
  }

  async saveLocal(fileId: string, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    if (!this.saveTransfer) throw new Error('Saving connected-app files is unavailable.')
    const transfer = await this.download(fileId, signal)
    return this.saveTransfer(String(transfer.id))
  }

  async #multipartUpload(name: string, mimeType: string, data: Buffer, parentId?: string, signal?: AbortSignal): Promise<JsonValue> {
    const boundary = `omnicode_${randomUUID().replace(/-/gu, '')}`
    const metadata = JSON.stringify({ name, ...(parentId ? { parents: [parentId] } : {}) })
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'),
      data,
      Buffer.from(`\r\n--${boundary}--`, 'utf8')
    ])
    return normalizeFile(await this.#json(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: body as unknown as BodyInit
    }, signal))
  }

  async rename(fileId: string, nameValue: string, signal?: AbortSignal): Promise<JsonValue> {
    const name = cleanText(nameValue, 1_000)
    if (!name || /[\r\n\0]/u.test(name)) throw new Error('Google Drive file name is invalid.')
    return this.#patch(fileId, { name }, signal)
  }

  async copy(fileId: string, nameValue?: string, signal?: AbortSignal): Promise<JsonValue> {
    const name = nameValue ? cleanText(nameValue, 1_000) : ''
    return normalizeFile(await this.#json(`${DRIVE_API}/files/${encodeURIComponent(requireId(fileId))}/copy?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: 'POST', body: JSON.stringify(name ? { name } : {})
    }, signal))
  }

  async move(fileId: string, destinationFolderId: string, signal?: AbortSignal): Promise<JsonValue> {
    const id = requireId(fileId)
    const destination = requireId(destinationFolderId, 'Google Drive destination folder ID')
    const current = await this.metadata(id, signal)
    const removeParents = Array.isArray(current.parents) ? current.parents.join(',') : ''
    const params = new URLSearchParams({ addParents: destination, fields: FILE_FIELDS, supportsAllDrives: 'true' })
    if (removeParents) params.set('removeParents', removeParents)
    return normalizeFile(await this.#json(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, { method: 'PATCH', body: '{}' }, signal))
  }

  trash(fileId: string, signal?: AbortSignal): Promise<JsonValue> { return this.#patch(fileId, { trashed: true }, signal) }
  restore(fileId: string, signal?: AbortSignal): Promise<JsonValue> { return this.#patch(fileId, { trashed: false }, signal) }

  registerTools(registry: ToolRegistry): void {
    const requiredScopes = [...GOOGLE_DRIVE_SCOPES]
    const base = { connectorId: 'google-drive', modes: ['work'] as const, requiredScopes }
    const readSafety = { category: 'read' as const, risk: 'low' as const, reversible: true, externalSideEffect: false }
    const routineWrite = { category: 'write' as const, risk: 'low' as const, reversible: true, externalSideEffect: true }
    const maximum = { type: 'integer' as const, minimum: 1, maximum: 50 }
    const fileId = { type: 'string' as const, minLength: 1, maxLength: 256 }
    registry.register({
      ...base, ...readSafety, id: 'drive.search', name: 'Search Google Drive', description: 'Search non-trashed Drive files by text.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1_000 }, maximum }, required: ['query', 'maximum'], additionalProperties: false }
    }, async (input, context) => this.search(String(input.query), Number(input.maximum), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'drive.recent', name: 'List recent Drive files', description: 'List recently modified non-trashed Drive files.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { maximum }, required: ['maximum'], additionalProperties: false }
    }, async (input, context) => this.listRecent(Number(input.maximum), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'drive.folder', name: 'List Drive folder', description: 'List the children of a Drive folder.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { folderId: fileId, maximum }, required: ['folderId', 'maximum'], additionalProperties: false }
    }, async (input, context) => this.listFolder(String(input.folderId), Number(input.maximum), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'drive.metadata', name: 'Read Drive metadata', description: 'Read bounded metadata for one Drive item.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { fileId }, required: ['fileId'], additionalProperties: false }
    }, async (input, context) => this.metadata(String(input.fileId), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'drive.read', name: 'Read Drive text file', description: 'Read bounded text or export a Google Doc, Sheet, or Slides file to text.', action: 'read', confirmation: 'never',
      inputSchema: { type: 'object', properties: { fileId }, required: ['fileId'], additionalProperties: false }
    }, async (input, context) => this.readText(String(input.fileId), context.signal))
    registry.register({
      ...base, ...readSafety, id: 'drive.download', name: 'Prepare Drive file', description: 'Download a Drive file into an opaque, short-lived app-private transfer for another connected app. File bytes and local paths are never sent to the AI.', action: 'read', confirmation: 'never', timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: { fileId }, required: ['fileId'], additionalProperties: false }
    }, async (input, context) => this.download(String(input.fileId), context.signal))
    registry.register({
      ...base, ...routineWrite, risk: 'medium', id: 'drive.save-local', name: 'Save Drive file to Mac', description: 'Download a Drive file and ask the user to choose its local destination in the native macOS save dialog.', action: 'write', confirmation: 'always', timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: { fileId }, required: ['fileId'], additionalProperties: false }
    }, async (input, context) => this.saveLocal(String(input.fileId), context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'drive.create-folder', name: 'Create Drive folder', description: 'Create a folder in Google Drive.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 1_000 }, parentId: fileId }, required: ['name'], additionalProperties: false }
    }, async (input, context) => this.createFolder(String(input.name), input.parentId === undefined ? undefined : String(input.parentId), context.signal))
    registry.register({
      ...base, category: 'sensitive-data', risk: 'medium', reversible: true, externalSideEffect: true, id: 'drive.upload-text', name: 'Upload text to Drive', description: 'Create a bounded text file in Google Drive.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 1_000 }, mimeType: { type: 'string', minLength: 1, maxLength: 300 }, content: { type: 'string', maxLength: MAX_FILE_TEXT_BYTES }, parentId: fileId }, required: ['name', 'mimeType', 'content'], additionalProperties: false }
    }, async (input, context) => this.upload(input, context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'drive.upload-transfer', name: 'Upload transferred file to Drive', description: 'Upload an opaque file transfer prepared by Gmail or Drive. The AI never receives the file bytes or a local path.', action: 'write', confirmation: 'policy', timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: { transferId: { type: 'string', minLength: 36, maxLength: 36 }, parentId: fileId, name: { type: 'string', minLength: 1, maxLength: 1_000 } }, required: ['transferId'], additionalProperties: false }
    }, async (input, context) => this.uploadTransfer(String(input.transferId), input.parentId === undefined ? undefined : String(input.parentId), input.name === undefined ? undefined : String(input.name), context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'drive.rename', name: 'Rename Drive item', description: 'Rename a Drive file or folder.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { fileId, name: { type: 'string', minLength: 1, maxLength: 1_000 } }, required: ['fileId', 'name'], additionalProperties: false }
    }, async (input, context) => this.rename(String(input.fileId), String(input.name), context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'drive.move', name: 'Move Drive item', description: 'Move a Drive file or folder to another folder.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { fileId, destinationFolderId: fileId }, required: ['fileId', 'destinationFolderId'], additionalProperties: false }
    }, async (input, context) => this.move(String(input.fileId), String(input.destinationFolderId), context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'drive.copy', name: 'Copy Drive file', description: 'Copy a Drive file, optionally with a new name.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { fileId, name: { type: 'string', minLength: 1, maxLength: 1_000 } }, required: ['fileId'], additionalProperties: false }
    }, async (input, context) => this.copy(String(input.fileId), input.name === undefined ? undefined : String(input.name), context.signal))
    registry.register({
      ...base, category: 'destructive', risk: 'high', reversible: true, externalSideEffect: true, id: 'drive.trash', name: 'Move Drive item to trash', description: 'Move a Drive file or folder to trash.', action: 'destructive', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { fileId }, required: ['fileId'], additionalProperties: false }
    }, async (input, context) => this.trash(String(input.fileId), context.signal))
    registry.register({
      ...base, ...routineWrite, id: 'drive.restore', name: 'Restore Drive item', description: 'Restore a trashed Drive file or folder.', action: 'write', confirmation: 'policy',
      inputSchema: { type: 'object', properties: { fileId }, required: ['fileId'], additionalProperties: false }
    }, async (input, context) => this.restore(String(input.fileId), context.signal))
  }

  async #list(parameters: Record<string, string>, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    const params = new URLSearchParams({ ...parameters, fields: `nextPageToken,files(${FILE_FIELDS})`, spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })
    const value = await this.#json(`${DRIVE_API}/files?${params}`, {}, signal) as { files?: unknown; nextPageToken?: unknown }
    if (!Array.isArray(value.files)) throw new Error('Google Drive returned an invalid file list.')
    return {
      files: value.files.slice(0, Number(parameters.pageSize) || 50).map(normalizeFile),
      nextPageToken: cleanText(value.nextPageToken, 2_048),
      untrustedContent: true
    }
  }

  async #patch(fileId: string, body: Record<string, JsonValue>, signal?: AbortSignal): Promise<JsonValue> {
    return normalizeFile(await this.#json(`${DRIVE_API}/files/${encodeURIComponent(requireId(fileId))}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: 'PATCH', body: JSON.stringify(body)
    }, signal))
  }

  async #request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const accessToken = await this.oauth.getAccessToken(GOOGLE_DRIVE_SCOPES)
    let response: Response
    try {
      response = await this.fetchApi(url, {
        ...init,
        signal: signal ?? init.signal,
        headers: { Accept: 'application/json', ...(init.body && !new Headers(init.headers).has('Content-Type') ? { 'Content-Type': 'application/json' } : {}), ...init.headers, Authorization: `Bearer ${accessToken}` }
      })
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new Error('Google Drive could not be reached. Check the network and try again.')
    }
    if (!response.ok) throw driveError(response.status)
    return response
  }

  async #json(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    return (await this.#request(url, init, signal)).json()
  }
}
