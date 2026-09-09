import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { WorkAttachment } from '../../shared/work-contracts'

const MAX_IMPORTED_FILE_BYTES = 2 * 1024 * 1024
const MAX_CONTEXT_BYTES = 400 * 1024
const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.csv', '.tsv', '.json', '.jsonc', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.java', '.c', '.h', '.cc', '.cpp',
  '.cxx', '.hh', '.hpp', '.swift', '.rs', '.go', '.php', '.rb', '.kt', '.kts', '.lua', '.xml', '.yaml',
  '.yml', '.toml', '.ini', '.cfg', '.conf', '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd'
])

function mimeTypeFor(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case '.md': case '.mdx': return 'text/markdown'
    case '.csv': return 'text/csv'
    case '.tsv': return 'text/tab-separated-values'
    case '.json': case '.jsonc': return 'application/json'
    case '.html': case '.htm': return 'text/html'
    case '.css': return 'text/css'
    case '.js': case '.mjs': case '.cjs': case '.jsx': return 'text/javascript'
    case '.ts': case '.mts': case '.cts': case '.tsx': return 'text/typescript'
    default: return 'text/plain'
  }
}

function safeId(value: string): string {
  if (typeof value !== 'string' || !ATTACHMENT_ID_PATTERN.test(value)) throw new Error('The Work attachment identifier is invalid.')
  return value
}

function safeDisplayName(target: string): string {
  const name = path.basename(target).normalize('NFC')
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('The selected file name is not supported.')
  return name
}

function decodeText(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error('This appears to be a binary file. Work Mode currently accepts text and source-code attachments.')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Error('Work Mode currently accepts UTF-8 text and source-code attachments.')
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

export class WorkAttachmentManager {
  constructor(private readonly root: string) {}

  async importFiles(targets: string[]): Promise<WorkAttachment[]> {
    if (!Array.isArray(targets) || !targets.length || targets.length > 20) throw new Error('Choose between 1 and 20 Work attachments.')
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const attachments: WorkAttachment[] = []
    try {
      for (const target of targets) attachments.push(await this.importFile(target))
      return attachments
    } catch (error) {
      await Promise.all(attachments.map((attachment) => this.remove(attachment.id).catch(() => undefined)))
      throw error
    }
  }

  async importFile(target: string): Promise<WorkAttachment> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const resolved = await fs.realpath(path.resolve(target))
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) throw new Error('Choose a regular file to attach.')
    if (stat.size > MAX_IMPORTED_FILE_BYTES) throw new Error('Work Mode currently limits each attachment to 2 MB.')
    const name = safeDisplayName(resolved)
    const extension = path.extname(name).toLowerCase()
    const specialTextName = ['dockerfile', 'makefile', 'gemfile', 'rakefile'].includes(name.toLowerCase())
    if (!TEXT_EXTENSIONS.has(extension) && !specialTextName) {
      throw new Error('Work Mode currently accepts UTF-8 text, Markdown, CSV, JSON, web files, and source code. PDF, Word, spreadsheet, and image extraction is not enabled yet.')
    }
    const buffer = await fs.readFile(resolved)
    decodeText(buffer)
    const id = randomUUID()
    const attachment: WorkAttachment = {
      id,
      name,
      kind: 'file',
      source: 'computer',
      createdAt: Date.now(),
      mimeType: mimeTypeFor(name),
      sizeBytes: buffer.byteLength,
      resourceId: id
    }
    const contentPath = path.join(this.root, `${id}.content`)
    const metadataPath = path.join(this.root, `${id}.json`)
    await fs.writeFile(contentPath, buffer, { mode: 0o600, flag: 'wx' })
    try {
      await fs.writeFile(metadataPath, JSON.stringify(attachment), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      await fs.unlink(contentPath).catch(() => undefined)
      throw error
    }
    return attachment
  }

  async context(ids: string[]): Promise<string> {
    if (!Array.isArray(ids) || ids.length > 20) throw new Error('Attach no more than 20 files to one Work message.')
    const uniqueIds = [...new Set(ids.map(safeId))]
    let remaining = MAX_CONTEXT_BYTES
    const sections: string[] = []
    for (const id of uniqueIds) {
      const metadata = JSON.parse(await fs.readFile(path.join(this.root, `${id}.json`), 'utf8')) as Partial<WorkAttachment>
      if (metadata.id !== id || typeof metadata.name !== 'string' || metadata.resourceId !== id) throw new Error('A Work attachment record is invalid.')
      const buffer = await fs.readFile(path.join(this.root, `${id}.content`))
      const text = decodeText(buffer)
      const header = `--- ${safeDisplayName(metadata.name)} ---\n`
      const headerBytes = Buffer.byteLength(header, 'utf8')
      if (remaining <= headerBytes) break
      const fullFits = Buffer.byteLength(text, 'utf8') <= remaining - headerBytes
      const marker = '\n[Attachment truncated by OmniCode’s context limit.]'
      const content = fullFits
        ? text
        : truncateUtf8(text, Math.max(0, remaining - headerBytes - Buffer.byteLength(marker, 'utf8')))
      const section = `${header}${content}${fullFits ? '' : marker}`
      sections.push(section)
      remaining -= Buffer.byteLength(section, 'utf8')
    }
    return sections.join('\n\n')
  }

  async remove(idValue: string): Promise<void> {
    const id = safeId(idValue)
    await Promise.all([
      fs.unlink(path.join(this.root, `${id}.content`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }),
      fs.unlink(path.join(this.root, `${id}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    ])
  }
}
