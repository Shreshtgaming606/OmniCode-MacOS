import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeSpotlightTitle, SpotlightManager, type SpotlightAdapter, type SpotlightConversation, type SpotlightItem } from './spotlight-manager'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

class FakeSpotlight implements SpotlightAdapter {
  items = new Map<string, SpotlightItem>()
  indexed: SpotlightItem[][] = []
  deleted: string[][] = []
  clearCount = 0
  async available(): Promise<boolean> { return true }
  async index(items: SpotlightItem[]): Promise<void> { this.indexed.push(items); for (const item of items) this.items.set(item.id, item) }
  async delete(ids: string[]): Promise<void> { this.deleted.push(ids); for (const id of ids) this.items.delete(id) }
  async clear(): Promise<void> { this.clearCount++; this.items.clear() }
  async query(text: string): Promise<SpotlightItem[]> { return [...this.items.values()].filter((item) => item.title.includes(text)) }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-spotlight-test-'))
  temporary.push(root)
  const native = new FakeSpotlight()
  let workspaces = [path.join(root, 'FTC Robot Vision')]
  let conversations: SpotlightConversation[] = [{ id: 'conv_1', title: 'Project planning', mode: 'work' }]
  const manager = new SpotlightManager(path.join(root, 'state.json'), { workspaces: async () => workspaces, conversations: async () => conversations }, native)
  return { root, native, manager, setWorkspaces: (value: string[]) => { workspaces = value }, setConversations: (value: typeof conversations) => { conversations = value } }
}

describe('SpotlightManager', () => {
  it('indexes only bounded metadata with opaque stable workspace IDs', async () => {
    const { manager, native, root } = await fixture()
    await manager.sync()
    const workspace = [...native.items.values()].find((item) => item.kind === 'workspace')!
    expect(workspace).toMatchObject({ title: 'FTC Robot Vision' })
    expect(workspace.id).toMatch(/^workspace:[0-9a-f-]{36}$/u)
    expect(JSON.stringify([...native.items.values()])).not.toContain(root)
    expect(await manager.resolveWorkspace(workspace.id.slice(10))).toBe(path.join(root, 'FTC Robot Vision'))
    await manager.sync()
    expect(native.indexed).toHaveLength(1)
    const restarted = new SpotlightManager(path.join(root, 'state.json'), { workspaces: async () => [path.join(root, 'FTC Robot Vision')], conversations: async () => [] }, native)
    await restarted.sync()
    expect([...native.items.values()].find((item) => item.kind === 'workspace')?.id).toBe(workspace.id)
  })

  it('updates changed titles, removes deleted entities, and excludes connected-app conversations', async () => {
    const { manager, native, setWorkspaces, setConversations } = await fixture()
    await manager.sync()
    const original = [...native.items.values()].find((item) => item.kind === 'workspace')!
    setWorkspaces([])
    setConversations([{ id: 'conv_2', title: 'Google account read', mode: 'work', containsConnectedData: true }])
    await manager.sync()
    expect(native.items.has(original.id)).toBe(false)
    expect([...native.items.values()].some((item) => item.kind === 'conversation')).toBe(false)
    expect(native.deleted.flat()).toContain(original.id)
    await expect(manager.resolveWorkspace(original.id.slice(10))).rejects.toThrow(/no longer available/i)
  })

  it('clears only its own index, disables automatic reindex, and rebuilds explicitly', async () => {
    const { manager, native } = await fixture()
    await manager.sync()
    await manager.clear()
    expect(native.clearCount).toBe(1)
    expect((await manager.settings()).enabled).toBe(false)
    await manager.sync()
    expect(native.items.size).toBe(0)
    await manager.updateSettings({ enabled: true, conversationTitles: false })
    expect([...native.items.values()].some((item) => item.kind === 'conversation')).toBe(false)
    await manager.rebuild()
    expect(native.clearCount).toBe(2)
    expect([...native.items.values()].some((item) => item.kind === 'workspace')).toBe(true)
  })

  it('rejects dangerous metadata and invalid settings', async () => {
    expect(sanitizeSpotlightTitle('sk-proj-12345678901234567890')).toBeNull()
    expect(sanitizeSpotlightTitle('password = secret')).toBeNull()
    expect(sanitizeSpotlightTitle('/Users/private/secret')).toBeNull()
    expect(sanitizeSpotlightTitle('  Project\nName  ')).toBe('Project Name')
    const { manager } = await fixture()
    await expect(manager.updateSettings({ enabled: 'yes' as unknown as boolean })).rejects.toThrow(/invalid/i)
  })
})
