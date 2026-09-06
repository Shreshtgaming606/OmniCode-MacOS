import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { rankIndexedFile, tokenize, WorkspaceIndexer, type IndexedFile } from './workspace-indexer'

describe('workspace retrieval', () => {
  it('tokenizes code-oriented terms', () => {
    expect(tokenize('Fix the LoginController error')).toContain('logincontroller')
    expect(tokenize('Fix the LoginController error')).not.toContain('the')
  })

  it('gives filenames and symbols more weight than body text', () => {
    const makeFile = (relativePath: string, symbols: string[], tokens: string[]): IndexedFile => ({
      path: `/tmp/${relativePath}`, relativePath, content: '', symbols, imports: [], tokens: new Set(tokens)
    })
    const named = makeFile('auth/login.ts', [], [])
    const bodyOnly = makeFile('misc.ts', [], ['login'])
    expect(rankIndexedFile(named, ['login'])).toBeGreaterThan(rankIndexedFile(bodyOnly, ['login']))
  })

  it('does not return README or manifest files that have no query match', () => {
    const readme: IndexedFile = {
      path: '/tmp/README.md', relativePath: 'README.md', content: 'Project overview',
      symbols: [], imports: [], tokens: new Set(['project', 'overview'])
    }
    expect(rankIndexedFile(readme, ['unrelatedmarker'])).toBe(0)
  })

  it('does not automatically index environment files or credential stores', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-index-'))
    try {
      await fs.mkdir(path.join(root, '.omnicode'))
      await fs.writeFile(path.join(root, 'main.ts'), 'export const visibleProjectToken = true')
      await fs.writeFile(path.join(root, '.env'), 'SUPER_SECRET_INDEX_TOKEN=hidden')
      await fs.writeFile(path.join(root, '.npmrc'), '//registry/:_authToken=hidden')
      await fs.writeFile(path.join(root, '.omnicode', 'settings.json'), '{"private":"hidden"}')
      const indexer = new WorkspaceIndexer()
      const status = await indexer.index(root)
      expect(status.fileCount).toBe(1)
      expect(indexer.relevant('visibleProjectToken')).toHaveLength(1)
      expect(indexer.relevant('visibleProjectToken', 8, path.join(root, 'other'))).toHaveLength(0)
      expect(indexer.relevant('SUPER_SECRET_INDEX_TOKEN')).toHaveLength(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('ignores unsafe and oversized workspace ignore configuration files', async () => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-index-'))
    try {
      const root = path.join(container, 'workspace')
      const outside = path.join(container, 'outside')
      await fs.mkdir(root)
      await fs.mkdir(outside)
      await fs.writeFile(path.join(root, 'visible.ts'), 'export const mustRemainVisible = true')
      await fs.writeFile(path.join(outside, 'gitignore'), 'visible.ts\n')
      await fs.writeFile(path.join(outside, 'settings.json'), JSON.stringify({ ai: { exclusions: ['visible.ts'] } }))
      await fs.symlink(path.join(outside, 'gitignore'), path.join(root, '.gitignore'))
      await fs.symlink(outside, path.join(root, '.omnicode'))
      await fs.writeFile(path.join(root, '.omnicodeignore'), 'x'.repeat(256 * 1024 + 1))

      const indexer = new WorkspaceIndexer()
      await indexer.index(root)
      expect(indexer.relevant('mustRemainVisible')).toHaveLength(1)
    } finally {
      await fs.rm(container, { recursive: true, force: true })
    }
  })

  it('replaces updated, created, renamed, and deleted files on each refresh', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-index-'))
    try {
      const original = path.join(root, 'original.ts')
      const created = path.join(root, 'created.ts')
      const renamed = path.join(root, 'renamed.ts')
      await fs.writeFile(original, 'export const ORIGINAL_CITRUS_MARKER = true')
      const indexer = new WorkspaceIndexer()
      await indexer.index(root)
      expect(indexer.relevant('ORIGINAL_CITRUS_MARKER').map((file) => file.path)).toEqual([original])

      await fs.writeFile(original, 'export const UPDATED_VIOLET_MARKER = true')
      await fs.writeFile(created, 'export const CREATED_COBALT_MARKER = true')
      await indexer.index(root)
      expect(indexer.relevant('ORIGINAL_CITRUS_MARKER')).toHaveLength(0)
      expect(indexer.relevant('UPDATED_VIOLET_MARKER').map((file) => file.path)).toEqual([original])
      expect(indexer.relevant('CREATED_COBALT_MARKER').map((file) => file.path)).toEqual([created])

      await fs.rename(created, renamed)
      await fs.rm(original)
      await indexer.index(root)
      expect(indexer.relevant('UPDATED_VIOLET_MARKER')).toHaveLength(0)
      expect(indexer.relevant('CREATED_COBALT_MARKER').map((file) => file.path)).toEqual([renamed])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
