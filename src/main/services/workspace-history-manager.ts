import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_RECENT_WORKSPACES = 12

export class WorkspaceHistoryManager {
  private readonly storagePath: string

  constructor(storagePath: string) {
    this.storagePath = storagePath
  }

  async list(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.storagePath, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      const unique = [...new Set(parsed.filter((item): item is string => typeof item === 'string').map((item) => path.resolve(item)))]
      const available: string[] = []
      for (const root of unique.slice(0, MAX_RECENT_WORKSPACES)) {
        try { if ((await fs.stat(root)).isDirectory()) available.push(root) } catch { /* remove unavailable entries */ }
      }
      if (available.length !== unique.length) await this.write(available)
      return available
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return []
    }
  }

  async add(root: string): Promise<string[]> {
    const resolved = path.resolve(root)
    const current = await this.list()
    const next = [resolved, ...current.filter((item) => item !== resolved)].slice(0, MAX_RECENT_WORKSPACES)
    await this.write(next)
    return next
  }

  async authorize(root: string): Promise<string> {
    const resolved = path.resolve(root)
    if (!(await this.list()).includes(resolved)) throw new Error('Choose this folder again to grant OmniCode access.')
    return resolved
  }

  private async write(value: string[]): Promise<void> {
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.storagePath)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

