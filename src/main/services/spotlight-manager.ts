import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SpotlightItem, SpotlightSettings } from '../../shared/spotlight-contracts'

export type { SpotlightItem, SpotlightSettings } from '../../shared/spotlight-contracts'

export interface SpotlightConversation {
  id: string
  title: string
  mode: 'work'
  containsConnectedData?: boolean
}

export interface SpotlightAdapter {
  available(): Promise<boolean>
  index(items: SpotlightItem[]): Promise<void>
  delete(ids: string[]): Promise<void>
  clear(): Promise<void>
  query(text: string, semantic: boolean): Promise<SpotlightItem[]>
}

interface Sources {
  workspaces(): Promise<string[]>
  conversations(): Promise<SpotlightConversation[]>
}

interface StoredState {
  version: 1
  settings: SpotlightSettings
  workspaceIds: Record<string, string>
  indexedItems: Record<string, string>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const DEFAULTS: SpotlightSettings = {
  enabled: true, recentWorkspaces: true, conversationTitles: true,
  savedWorkflows: false, workspaceFilenames: false
}

export function sanitizeSpotlightTitle(value: string): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120)
  if (!text || /(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=])/iu.test(text)) return null
  if (/(?:\/Users\/|\/private\/|\/Volumes\/|\.env(?:\.|$)|-----BEGIN .*PRIVATE KEY-----)/iu.test(text)) return null
  return text
}

export function stableSpotlightWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function defaults(): StoredState {
  return { version: 1, settings: { ...DEFAULTS }, workspaceIds: {}, indexedItems: {} }
}

function validateStored(value: unknown): StoredState {
  if (!value || typeof value !== 'object') return defaults()
  const state = value as Partial<StoredState>
  if (state.version !== 1 || !state.settings || !state.workspaceIds || !state.indexedItems || typeof state.indexedItems !== 'object') return defaults()
  const settings = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, (state.settings as unknown as Record<string, unknown>)[key] === true])) as unknown as SpotlightSettings
  const workspaceIds: Record<string, string> = {}
  for (const [root, id] of Object.entries(state.workspaceIds)) {
    if (path.isAbsolute(root) && stableSpotlightWorkspaceId(id)) workspaceIds[root] = id
  }
  const indexedItems: Record<string, string> = {}
  for (const [id, fingerprint] of Object.entries(state.indexedItems).slice(0, 300)) {
    if (/^(?:workspace:[0-9a-f-]{36}|conversation:work:[A-Za-z0-9_-]{1,128}|action:[a-z-]{1,40})$/u.test(id) && typeof fingerprint === 'string' && fingerprint.length <= 200) indexedItems[id] = fingerprint
  }
  return { version: 1, settings, workspaceIds, indexedItems }
}

const ACTIONS: SpotlightItem[] = [
  { id: 'action:open-code', title: 'Open Code Mode in OmniCode', kind: 'action' },
  { id: 'action:open-work', title: 'Open Work Mode in OmniCode', kind: 'action' },
  { id: 'action:open-omni', title: 'Open Omni Mode in OmniCode', kind: 'action' },
  { id: 'action:start-voice', title: 'Start Omni Voice', kind: 'action' }
]

export class SpotlightManager {
  private queue: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly storagePath: string, private readonly sources: Sources, private readonly native: SpotlightAdapter) {
    if (!path.isAbsolute(storagePath)) throw new Error('Spotlight settings require an absolute storage path.')
  }

  async settings(): Promise<SpotlightSettings & { available: boolean }> {
    const state = await this.read()
    return { ...state.settings, available: await this.native.available().catch(() => false) }
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.sync().catch(() => undefined)
    }, 1_500)
  }

  sync(): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.read()
      if (!state.settings.enabled || !(await this.native.available())) return
      const previous = new Set(Object.keys(state.indexedItems))
      const items = await this.desiredItems(state)
      const desired = new Set(items.map((item) => item.id))
      const removed = [...previous].filter((id) => !desired.has(id))
      if (removed.length) await this.native.delete(removed)
      const changed = items.filter((item) => state.indexedItems[item.id] !== `${item.kind}:${item.title}`)
      if (changed.length) await this.native.index(changed)
      state.indexedItems = Object.fromEntries(items.map((item) => [item.id, `${item.kind}:${item.title}`]))
      await this.write(state)
    })
  }

  rebuild(): Promise<void> {
    return this.enqueue(async () => {
      if (!(await this.native.available())) throw new Error('Spotlight indexing is unavailable on this Mac.')
      const state = await this.read()
      await this.native.clear()
      state.indexedItems = {}
      if (state.settings.enabled) {
        const items = await this.desiredItems(state)
        if (items.length) await this.native.index(items)
        state.indexedItems = Object.fromEntries(items.map((item) => [item.id, `${item.kind}:${item.title}`]))
      }
      await this.write(state)
    })
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.native.clear()
      const state = await this.read()
      state.settings.enabled = false
      state.indexedItems = {}
      await this.write(state)
    })
  }

  updateSettings(update: Partial<SpotlightSettings>): Promise<SpotlightSettings> {
    return this.enqueue(async () => {
      if (!update || typeof update !== 'object' || Object.keys(update).some((key) => !(key in DEFAULTS) || typeof update[key as keyof SpotlightSettings] !== 'boolean')) {
        throw new Error('Spotlight settings are invalid.')
      }
      const state = await this.read()
      state.settings = { ...state.settings, ...update }
      await this.write(state)
      if (!state.settings.enabled) await this.native.clear()
      else {
        const items = await this.desiredItems(state)
        const desired = new Set(items.map((item) => item.id))
        const removed = Object.keys(state.indexedItems).filter((id) => !desired.has(id))
        if (removed.length) await this.native.delete(removed)
        const changed = items.filter((item) => state.indexedItems[item.id] !== `${item.kind}:${item.title}`)
        if (changed.length) await this.native.index(changed)
        state.indexedItems = Object.fromEntries(items.map((item) => [item.id, `${item.kind}:${item.title}`]))
        await this.write(state)
      }
      return { ...state.settings }
    })
  }

  search(text: string, semantic: boolean): Promise<SpotlightItem[]> {
    if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('Search text is invalid.')
    return this.native.query(text.trim(), semantic)
  }

  async resolveWorkspace(id: string): Promise<string> {
    if (!stableSpotlightWorkspaceId(id)) throw new Error('Workspace identifier is invalid.')
    const state = await this.read()
    const entry = Object.entries(state.workspaceIds).find(([, value]) => value === id)
    if (!entry || !(await this.sources.workspaces()).includes(entry[0])) throw new Error('The indexed workspace is no longer available.')
    return entry[0]
  }

  private async desiredItems(state: StoredState): Promise<SpotlightItem[]> {
    const items: SpotlightItem[] = [...ACTIONS]
    if (state.settings.recentWorkspaces) {
      const roots = (await this.sources.workspaces()).slice(0, 12)
      for (const root of roots) {
        if (!path.isAbsolute(root)) continue
        const title = sanitizeSpotlightTitle(path.basename(root))
        if (!title) continue
        if (!state.workspaceIds[root]) state.workspaceIds[root] = randomUUID()
        items.push({ id: `workspace:${state.workspaceIds[root]}`, title, kind: 'workspace' })
      }
      for (const root of Object.keys(state.workspaceIds)) if (!roots.includes(root)) delete state.workspaceIds[root]
    }
    if (state.settings.conversationTitles) {
      for (const conversation of (await this.sources.conversations()).slice(0, 100)) {
        if (conversation.mode !== 'work' || conversation.containsConnectedData || !SAFE_ID.test(conversation.id)) continue
        const title = sanitizeSpotlightTitle(conversation.title)
        if (title && title !== 'New chat') items.push({ id: `conversation:work:${conversation.id}`, title, kind: 'conversation' })
      }
    }
    return items
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async read(): Promise<StoredState> {
    try { return validateStored(JSON.parse(await fs.readFile(this.storagePath, 'utf8')) as unknown) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults(); throw error }
  }

  private async write(value: StoredState): Promise<void> {
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.storagePath)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export class NativeSpotlightAdapter implements SpotlightAdapter {
  private binding: { operate(request: string): Promise<string> } | null = null

  constructor(private readonly addonPath: string) {}

  private async call<T>(request: object): Promise<T> {
    if (!this.binding) this.binding = require(this.addonPath) as { operate(request: string): Promise<string> }
    return JSON.parse(await this.binding.operate(JSON.stringify(request))) as T
  }

  async available(): Promise<boolean> { return (await this.call<{ available: boolean }>({ command: 'status' })).available }
  async index(items: SpotlightItem[]): Promise<void> { await this.call({ command: 'index', items }) }
  async delete(ids: string[]): Promise<void> { await this.call({ command: 'delete', ids }) }
  async clear(): Promise<void> { await this.call({ command: 'clear' }) }
  async query(text: string, semantic: boolean): Promise<SpotlightItem[]> {
    const response = await this.call<{ items: Array<{ id: string; title: string }> }>({ command: 'query', text, semantic })
    return response.items.flatMap((item): SpotlightItem[] => {
      const kind = item.id.startsWith('workspace:') ? 'workspace' : item.id.startsWith('conversation:work:') ? 'conversation' : item.id.startsWith('action:') ? 'action' : null
      return kind && typeof item.title === 'string' ? [{ ...item, kind }] : []
    })
  }
}
