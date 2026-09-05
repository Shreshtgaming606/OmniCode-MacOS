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
})
