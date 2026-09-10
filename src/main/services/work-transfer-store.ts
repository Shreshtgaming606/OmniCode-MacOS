import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { JsonValue } from '../../shared/tool-contracts'

const TRANSFER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_TRANSFER_BYTES = 24 * 1024 * 1024
const MAX_TRANSFER_AGE_MS = 60 * 60 * 1_000

export interface WorkTransferRecord {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  source: string
  createdAt: string
}

export type SaveWorkTransfer = (transferId: string) => Promise<Record<string, JsonValue>>

function safeFilename(value: string): string {
  const clean = path.basename(value)
    .replace(/[\u0000-\u001f\u007f/\\:]/gu, '_')
    .trim()
    .slice(0, 240)
  if (!clean || clean === '.' || clean === '..') throw new Error('The transfer filename is invalid.')
  return clean
}

function safeMimeType(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(normalized)) {
    throw new Error('The transfer media type is invalid.')
  }
  return normalized
}

function publicRecord(record: WorkTransferRecord): Record<string, JsonValue> {
  return { ...record }
}

export class WorkTransferStore {
  readonly #records = new Map<string, WorkTransferRecord>()

  constructor(private readonly directory: string) {}

  async put(input: { filename: string; mimeType: string; data: Buffer; source: string }): Promise<Record<string, JsonValue>> {
    if (!Buffer.isBuffer(input.data) || input.data.byteLength < 1 || input.data.byteLength > MAX_TRANSFER_BYTES) {
      throw new Error(`Connected-app transfers must contain between 1 byte and ${MAX_TRANSFER_BYTES} bytes.`)
    }
    const id = randomUUID()
    const record: WorkTransferRecord = {
      id,
      filename: safeFilename(input.filename),
      mimeType: safeMimeType(input.mimeType || 'application/octet-stream'),
      sizeBytes: input.data.byteLength,
      source: input.source.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 120) || 'connected-app',
      createdAt: new Date().toISOString()
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.prune().catch(() => undefined)
    const target = path.join(this.directory, id)
    await fs.writeFile(target, input.data, { mode: 0o600, flag: 'wx' })
    this.#records.set(id, record)
    return publicRecord(record)
  }

  async get(id: string): Promise<{ record: WorkTransferRecord; data: Buffer }> {
    if (!TRANSFER_ID_PATTERN.test(id)) throw new Error('The connected-app transfer identifier is invalid.')
    const record = this.#records.get(id)
    if (!record) throw new Error('The connected-app transfer expired or is unavailable.')
    const createdAt = Date.parse(record.createdAt)
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > MAX_TRANSFER_AGE_MS) {
      await this.remove(id)
      throw new Error('The connected-app transfer expired or is unavailable.')
    }
    const data = await fs.readFile(path.join(this.directory, id))
    if (data.byteLength !== record.sizeBytes || data.byteLength > MAX_TRANSFER_BYTES) {
      await this.remove(id)
      throw new Error('The connected-app transfer failed its integrity check.')
    }
    return { record: { ...record }, data }
  }

  async remove(id: string): Promise<void> {
    if (!TRANSFER_ID_PATTERN.test(id)) throw new Error('The connected-app transfer identifier is invalid.')
    this.#records.delete(id)
    await fs.rm(path.join(this.directory, id), { force: true })
  }

  async prune(): Promise<void> {
    const cutoff = Date.now() - MAX_TRANSFER_AGE_MS
    for (const [id, record] of this.#records) {
      if (Date.parse(record.createdAt) < cutoff) await this.remove(id)
    }
    const entries = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    await Promise.all(entries.filter((entry) => !this.#records.has(entry)).map(async (entry) => {
      if (TRANSFER_ID_PATTERN.test(entry)) await fs.rm(path.join(this.directory, entry), { force: true })
    }))
  }

  async clear(): Promise<void> {
    this.#records.clear()
    await fs.rm(this.directory, { recursive: true, force: true })
  }
}
