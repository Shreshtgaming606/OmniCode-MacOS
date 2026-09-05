import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { DiffProposalChangeInput } from '../../shared/contracts'
import { DiffManager } from './diff-manager'
import { FileSystemManager } from './filesystem-manager'

const temporaryRoots: string[] = []

async function fixture(files: Record<string, string>): Promise<{
  root: string
  manager: DiffManager
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-diff-'))
  temporaryRoots.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  const fileSystem = new FileSystemManager()
  fileSystem.setWorkspace(root)
  return { root, manager: new DiffManager(fileSystem) }
}

function request(root: string, changes: DiffProposalChangeInput[]) {
  return { workspaceRoot: root, title: 'Test proposal', changes }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('DiffManager', () => {
  it('keeps proposed content in memory and returns a unified diff before acceptance', async () => {
    const { root, manager } = await fixture({
      'src/app.ts': 'const answer = 41\nconsole.log(answer)\n'
    })
    const target = path.join(root, 'src/app.ts')

    const proposal = await manager.propose(request(root, [{
      kind: 'modify',
      path: 'src/app.ts',
      content: 'const answer = 42\nconsole.log(answer)\n'
    }]))

    expect(await fs.readFile(target, 'utf8')).toBe('const answer = 41\nconsole.log(answer)\n')
    expect(proposal.status).toBe('pending')
    expect(proposal.files[0]?.unifiedDiff).toContain('-const answer = 41')
    expect(proposal.files[0]?.unifiedDiff).toContain('+const answer = 42')
    expect(proposal.files[0]?.currentContent).toContain('41')
    expect(proposal.files[0]?.reviewContent).toContain('42')
  })

  it('accepts and rejects independent hunks without applying rejected text', async () => {
    const original = [
      'line 1',
      'old first',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'old second',
      'line 12'
    ].join('\n') + '\n'
    const proposed = original.replace('old first', 'new first').replace('old second', 'new second')
    const { root, manager } = await fixture({ 'two-hunks.txt': original })
    const created = await manager.propose(request(root, [{
      kind: 'modify',
      path: 'two-hunks.txt',
      content: proposed
    }]))
    const file = created.files[0]
    expect(file?.hunks).toHaveLength(2)
    if (!file?.hunks[0] || !file.hunks[1]) throw new Error('Expected two hunks')

    const accepted = await manager.accept(created.id, {
      scope: 'hunk',
      fileId: file.id,
      hunkId: file.hunks[0].id
    })
    expect(await fs.readFile(path.join(root, 'two-hunks.txt'), 'utf8')).toContain('new first')
    expect(await fs.readFile(path.join(root, 'two-hunks.txt'), 'utf8')).toContain('old second')
    expect(accepted.canUndo).toBe(true)

    const rejected = await manager.reject(created.id, {
      scope: 'hunk',
      fileId: file.id,
      hunkId: file.hunks[1].id
    })
    const disk = await fs.readFile(path.join(root, 'two-hunks.txt'), 'utf8')
    expect(disk).toContain('new first')
    expect(disk).toContain('old second')
    expect(disk).not.toContain('new second')
    expect(rejected.files[0]?.status).toBe('partial')
  })

  it('accepts a multi-file transaction and restores its snapshot with undo', async () => {
    const { root, manager } = await fixture({
      'keep.txt': 'before\n',
      'remove.txt': 'restore me\n'
    })
    const proposal = await manager.propose(request(root, [
      { kind: 'modify', path: 'keep.txt', content: 'after\n' },
      { kind: 'create', path: 'created.txt', content: 'new file\n' },
      { kind: 'delete', path: 'remove.txt' }
    ]))

    const accepted = await manager.accept(proposal.id, { scope: 'all' })
    expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('after\n')
    expect(await fs.readFile(path.join(root, 'created.txt'), 'utf8')).toBe('new file\n')
    await expect(fs.access(path.join(root, 'remove.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(accepted.status).toBe('accepted')
    expect(accepted.canUndo).toBe(true)

    const undone = await manager.undo(proposal.id)
    expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('before\n')
    expect(await fs.readFile(path.join(root, 'remove.txt'), 'utf8')).toBe('restore me\n')
    await expect(fs.access(path.join(root, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(undone.status).toBe('pending')
    expect(undone.canUndo).toBe(false)
  })

  it('refuses to overwrite a file changed externally after proposal creation', async () => {
    const { root, manager } = await fixture({ 'conflict.txt': 'base\n' })
    const target = path.join(root, 'conflict.txt')
    const proposal = await manager.propose(request(root, [{
      kind: 'modify',
      path: 'conflict.txt',
      content: 'AI version\n'
    }]))
    await fs.writeFile(target, 'external version\n', 'utf8')

    await expect(manager.accept(proposal.id, { scope: 'all' })).rejects.toThrow('changed on disk')
    expect(await fs.readFile(target, 'utf8')).toBe('external version\n')
    expect(manager.get(proposal.id).status).toBe('pending')
  })

  it('rejects traversal outside the active workspace', async () => {
    const { root, manager } = await fixture({ 'inside.txt': 'inside\n' })
    await expect(manager.propose(request(root, [{
      kind: 'create',
      path: '../outside.txt',
      content: 'blocked\n'
    }]))).rejects.toThrow('outside')
  })

  it('revalidates canonical paths when a missing directory becomes an escaping symlink', async () => {
    const { root, manager } = await fixture({ 'inside.txt': 'inside\n' })
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-diff-outside-'))
    temporaryRoots.push(outside)
    const proposal = await manager.propose(request(root, [{
      kind: 'create',
      path: 'late-link/escaped.txt',
      content: 'must remain contained\n'
    }]))
    await fs.symlink(outside, path.join(root, 'late-link'))

    await expect(manager.accept(proposal.id, { scope: 'all' })).rejects.toThrow('symbolic link')
    await expect(fs.access(path.join(outside, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(manager.get(proposal.id).status).toBe('pending')
  })

  it('rejects a file proposal without writing to disk', async () => {
    const { root, manager } = await fixture({ 'stable.txt': 'stable\n' })
    const proposal = await manager.propose(request(root, [{
      kind: 'modify',
      path: 'stable.txt',
      content: 'changed\n'
    }]))
    const file = proposal.files[0]
    if (!file) throw new Error('Expected a proposed file')

    const rejected = await manager.reject(proposal.id, { scope: 'file', fileId: file.id })
    expect(await fs.readFile(path.join(root, 'stable.txt'), 'utf8')).toBe('stable\n')
    expect(rejected.status).toBe('rejected')
  })
})
