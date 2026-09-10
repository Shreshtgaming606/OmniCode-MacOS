import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkTransferStore } from './work-transfer-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function store(): Promise<{ root: string; transfers: WorkTransferStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-transfer-test-'))
  roots.push(root)
  return { root, transfers: new WorkTransferStore(path.join(root, 'transfers')) }
}

describe('WorkTransferStore', () => {
  it('stores opaque private transfers without exposing a filesystem path', async () => {
    const { root, transfers } = await store()
    const metadata = await transfers.put({
      filename: '../teacher report.pdf', mimeType: 'application/pdf', data: Buffer.from('pdf-bytes'), source: 'gmail'
    })

    expect(metadata).toMatchObject({ filename: 'teacher report.pdf', mimeType: 'application/pdf', sizeBytes: 9, source: 'gmail' })
    expect(metadata).not.toHaveProperty('path')
    const loaded = await transfers.get(String(metadata.id))
    expect(loaded.data.toString()).toBe('pdf-bytes')
    expect((await fs.stat(path.join(root, 'transfers', String(metadata.id)))).mode & 0o777).toBe(0o600)
  })

  it('rejects unsafe metadata, invalid IDs, and empty or oversized payloads', async () => {
    const { transfers } = await store()
    await expect(transfers.put({ filename: '..', mimeType: 'application/pdf', data: Buffer.from('x'), source: 'gmail' })).rejects.toThrow('filename')
    await expect(transfers.put({ filename: 'file.bin', mimeType: 'bad type', data: Buffer.from('x'), source: 'gmail' })).rejects.toThrow('media type')
    await expect(transfers.put({ filename: 'empty.txt', mimeType: 'text/plain', data: Buffer.alloc(0), source: 'gmail' })).rejects.toThrow('between 1 byte')
    await expect(transfers.get('../outside')).rejects.toThrow('identifier')
  })

  it('removes transfer bytes on clear', async () => {
    const { root, transfers } = await store()
    const metadata = await transfers.put({ filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('notes'), source: 'drive' })
    await transfers.clear()
    await expect(transfers.get(String(metadata.id))).rejects.toThrow('unavailable')
    await expect(fs.stat(path.join(root, 'transfers'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
