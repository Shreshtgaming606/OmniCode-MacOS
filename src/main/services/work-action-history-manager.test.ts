import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkActionHistoryManager } from './work-action-history-manager'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function manager(): Promise<{ manager: WorkActionHistoryManager; file: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-work-history-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, 'history.json')
  return { manager: new WorkActionHistoryManager(file), file }
}

describe('WorkActionHistoryManager', () => {
  it('persists only bounded safe action metadata and clears it', async () => {
    const { manager: history, file } = await manager()
    await history.add({
      timestamp: 1,
      completedAt: 2,
      toolId: 'gmail.send',
      toolName: 'Send Gmail message',
      connectorId: 'gmail',
      connectorName: 'Gmail',
      category: 'communication',
      risk: 'medium',
      approvalMode: 'ask',
      approval: 'user-approved',
      result: 'succeeded',
      summary: 'Send Gmail message completed. Authorization: Bearer history-secret'
    })
    const restarted = new WorkActionHistoryManager(file)
    await expect(restarted.list()).resolves.toMatchObject([{ toolId: 'gmail.send', approval: 'user-approved' }])
    const raw = await fs.readFile(file, 'utf8')
    expect(raw).not.toMatch(/access[_-]?token|history-secret|password|recipient@example/iu)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    await restarted.clear()
    await expect(restarted.list()).resolves.toEqual([])
  })

  it('fails closed to an empty history for corrupt or oversized state', async () => {
    const { manager: history, file } = await manager()
    await fs.writeFile(file, '{broken')
    await expect(history.list()).resolves.toEqual([])
    await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1))
    await expect(history.list()).resolves.toEqual([])
  })
})
