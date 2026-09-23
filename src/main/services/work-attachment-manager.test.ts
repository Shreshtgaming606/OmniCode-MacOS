import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorkAttachmentManager } from './work-attachment-manager'

const temporaryRoots: string[] = []

async function fixture(): Promise<{ root: string; source: string; manager: WorkAttachmentManager }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-work-attachments-'))
  temporaryRoots.push(root)
  const source = path.join(root, 'source')
  const store = path.join(root, 'store')
  await fs.mkdir(source)
  return { root, source, manager: new WorkAttachmentManager(store) }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('WorkAttachmentManager', () => {
  it('imports a user-selected UTF-8 file into a private durable store and returns bounded context', async () => {
    const { root, source, manager } = await fixture()
    const selected = path.join(source, 'Project notes Ω.md')
    await fs.writeFile(selected, '# Plan\nShip OmniCode safely.\n')

    const attachment = await manager.importFile(selected)
    expect(attachment).toMatchObject({
      name: 'Project notes Ω.md', kind: 'file', source: 'computer', mimeType: 'text/markdown'
    })
    expect(await manager.context([attachment.id])).toContain('Ship OmniCode safely.')
    const contentStat = await fs.stat(path.join(root, 'store', `${attachment.id}.content`))
    const metadataStat = await fs.stat(path.join(root, 'store', `${attachment.id}.json`))
    expect(contentStat.mode & 0o777).toBe(0o600)
    expect(metadataStat.mode & 0o777).toBe(0o600)

    await fs.unlink(selected)
    await expect(manager.context([attachment.id])).resolves.toContain('Ship OmniCode safely.')
  })

  it('rejects binary and unsupported document formats instead of pretending to extract them', async () => {
    const { source, manager } = await fixture()
    const binary = path.join(source, 'binary.txt')
    const document = path.join(source, 'report.pdf')
    await fs.writeFile(binary, Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(document, 'not really a PDF')

    await expect(manager.importFile(binary)).rejects.toThrow(/binary file/i)
    await expect(manager.importFile(document)).rejects.toThrow(/PDF, Word, spreadsheet, and image extraction is not enabled/i)
  })

  it('removes only generated attachment records and validates identifiers', async () => {
    const { source, manager } = await fixture()
    const selected = path.join(source, 'notes.txt')
    await fs.writeFile(selected, 'temporary context')
    const attachment = await manager.importFile(selected)

    await manager.remove(attachment.id)
    await expect(manager.context([attachment.id])).rejects.toThrow()
    await expect(manager.remove('../../outside')).rejects.toThrow(/identifier is invalid/i)
  })

  it('prunes orphaned attachment pairs while retaining referenced attachments', async () => {
    const { root, source, manager } = await fixture()
    const first = path.join(source, 'first.txt')
    const second = path.join(source, 'second.txt')
    await fs.writeFile(first, 'keep me')
    await fs.writeFile(second, 'remove me')
    const kept = await manager.importFile(first)
    const removed = await manager.importFile(second)

    await manager.removeUnreferenced([kept.id])

    await expect(manager.context([kept.id])).resolves.toContain('keep me')
    await expect(manager.context([removed.id])).rejects.toThrow()
    await expect(fs.stat(path.join(root, 'store', `${removed.id}.content`))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
