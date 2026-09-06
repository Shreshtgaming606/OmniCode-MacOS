import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GitManager, parseGitStatus, redactGitOutput, runGit } from './git-manager'

const temporaryDirectories: string[] = []

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-git-'))
  temporaryDirectories.push(root)
  await runGit(root, ['init'])
  await runGit(root, ['config', 'user.email', 'tests@omnicode.local'])
  await runGit(root, ['config', 'user.name', 'OmniCode Tests'])
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('parseGitStatus', () => {
  it('preserves dots in branch names and parses tracking counts', () => {
    const result = parseGitStatus('## feature/editor.v2...origin/feature/editor.v2 [ahead 2, behind 1]\0 M file.ts\0')
    expect(result.branch).toBe('feature/editor.v2')
    expect(result.ahead).toBe(2)
    expect(result.behind).toBe(1)
    expect(result.changes[0]).toMatchObject({ path: 'file.ts', indexStatus: ' ', workingTreeStatus: 'M' })
  })

  it('keeps the destination and records the original path for renames', () => {
    const result = parseGitStatus('## main\0R  src/new.ts\0src/old.ts\0')
    expect(result.changes).toEqual([{
      path: 'src/new.ts',
      originalPath: 'src/old.ts',
      indexStatus: 'R',
      workingTreeStatus: ' '
    }])
  })

  it('consumes the original path for a working-tree rename', () => {
    const result = parseGitStatus('## main\0 R src/new.ts\0src/old.ts\0 M other.ts\0')
    expect(result.changes).toEqual([
      { path: 'src/new.ts', originalPath: 'src/old.ts', indexStatus: ' ', workingTreeStatus: 'R' },
      { path: 'other.ts', originalPath: undefined, indexStatus: ' ', workingTreeStatus: 'M' }
    ])
  })
})

describe('redactGitOutput', () => {
  it('removes URL credentials, token parameters, and recognizable GitHub tokens', () => {
    const output = redactGitOutput('fatal: https://user:secret@example.test/repo?access_token=visible ghp_abcdefghijklmnopqrstuvwxyz123456')
    expect(output).toBe('fatal: https://user:••••@example.test/repo?access_token=•••• ••••')
    expect(output).not.toMatch(/secret|visible|ghp_/u)
  })
})

describe('GitManager', () => {
  it('supports initial staging, unstaging, commits, diffs, and branch lifecycle', async () => {
    const root = await repository()
    const manager = new GitManager()
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello\n')

    expect((await manager.status(root)).changes[0]).toMatchObject({ path: 'hello.txt', indexStatus: '?', workingTreeStatus: '?' })
    await manager.stage(root, ['hello.txt'])
    expect((await manager.status(root)).changes[0]?.indexStatus).toBe('A')
    await manager.unstage(root, ['hello.txt'])
    expect((await manager.status(root)).changes[0]?.indexStatus).toBe('?')

    await manager.stage(root, ['.'])
    await manager.commit(root, 'Initial commit')
    const initialBranch = (await manager.status(root)).branch
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world\n')
    expect(await manager.diff(root, 'hello.txt')).toContain('+hello world')
    await manager.stage(root, ['hello.txt'])
    expect(await manager.diff(root, 'hello.txt', true)).toContain('+hello world')
    await manager.commit(root, 'Update greeting')

    await manager.switchBranch(root, 'feature/editor-v2', true)
    expect((await manager.status(root)).branch).toBe('feature/editor-v2')
    expect(await manager.branches(root)).toContain('feature/editor-v2')
    await manager.switchBranch(root, initialBranch)
    await manager.deleteBranch(root, 'feature/editor-v2')
    expect(await manager.branches(root)).not.toContain('feature/editor-v2')
  })

  it('renders an untracked file as a no-index diff and rejects escaping paths', async () => {
    const root = await repository()
    const manager = new GitManager()
    await fs.writeFile(path.join(root, 'new.txt'), 'new file\n')
    expect(await manager.diff(root, 'new.txt')).toContain('+new file')
    await expect(manager.stage(root, ['../outside.txt'])).rejects.toThrow(/inside the workspace|leave the workspace/i)
  })

  it('does not execute a repository-configured fsmonitor during automatic status', async () => {
    const root = await repository()
    const marker = path.join(root, 'fsmonitor-ran')
    const hook = path.join(root, 'fsmonitor-hook.sh')
    await fs.writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o700 })
    await runGit(root, ['config', 'core.fsmonitor', hook])

    await new GitManager().status(root)
    await expect(fs.access(marker)).rejects.toThrow()
  })

  it('clones, fetches, pulls, and pushes against a real local bare remote', async () => {
    const source = await repository()
    const remoteContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-git-remote-'))
    const cloneContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-git-clone-'))
    temporaryDirectories.push(remoteContainer, cloneContainer)
    const remote = path.join(remoteContainer, 'omnicode-audit.git')
    await fs.mkdir(remote)
    await runGit(remote, ['init', '--bare'])
    await fs.writeFile(path.join(source, 'shared.txt'), 'one\n')
    await runGit(source, ['add', '--', 'shared.txt'])
    await runGit(source, ['commit', '-m', 'Initial remote content'])
    const branch = (await new GitManager().status(source)).branch
    await runGit(source, ['remote', 'add', 'origin', remote])
    await runGit(source, ['push', '--set-upstream', 'origin', branch])

    const manager = new GitManager()
    const cloned = await manager.clone(cloneContainer, remote)
    await runGit(cloned, ['config', 'user.email', 'tests@omnicode.local'])
    await runGit(cloned, ['config', 'user.name', 'OmniCode Tests'])
    expect(await fs.readFile(path.join(cloned, 'shared.txt'), 'utf8')).toBe('one\n')
    await fs.writeFile(path.join(cloned, 'shared.txt'), 'one\ntwo\n')
    await manager.stage(cloned, ['shared.txt'])
    await manager.commit(cloned, 'Update from clone')
    await manager.operation(cloned, 'push')

    await manager.operation(source, 'fetch')
    await manager.operation(source, 'pull')
    expect(await fs.readFile(path.join(source, 'shared.txt'), 'utf8')).toBe('one\ntwo\n')
  })
})
