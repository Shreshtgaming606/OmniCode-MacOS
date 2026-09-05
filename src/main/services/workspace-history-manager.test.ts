import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorkspaceHistoryManager } from './workspace-history-manager'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('WorkspaceHistoryManager', () => {
  it('only authorizes folders previously added through a trusted flow', async () => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-history-'))
    temporaryDirectories.push(container)
    const first = path.join(container, 'first')
    const unknown = path.join(container, 'unknown')
    await fs.mkdir(first)
    await fs.mkdir(unknown)
    const history = new WorkspaceHistoryManager(path.join(container, 'state', 'recent.json'))

    await expect(history.authorize(unknown)).rejects.toThrow(/choose this folder again/i)
    await history.add(first)
    await expect(history.authorize(first)).resolves.toBe(path.resolve(first))
    expect(await history.list()).toEqual([path.resolve(first)])
  })

  it('removes unavailable folders from persisted recents', async () => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-history-'))
    temporaryDirectories.push(container)
    const root = path.join(container, 'project')
    await fs.mkdir(root)
    const history = new WorkspaceHistoryManager(path.join(container, 'recent.json'))
    await history.add(root)
    await fs.rm(root, { recursive: true })
    expect(await history.list()).toEqual([])
  })
})
