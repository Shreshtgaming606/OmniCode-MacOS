import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DevServerManager } from './dev-server-manager'
import { DiffManager } from './diff-manager'
import { FileSystemManager } from './filesystem-manager'
import type { GitManager } from './git-manager'
import type { TerminalManager } from './terminal-manager'
import { CodeAgentToolService } from './code-agent-tool-service'
import { ToolRegistry } from './tool-registry'

const roots: string[] = []

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omnicode-code-tools-'))
  const external = await mkdtemp(path.join(os.tmpdir(), 'omnicode-code-external-'))
  roots.push(root, external)
  await writeFile(path.join(root, 'source.ts'), 'export const value = 1\n')
  await writeFile(path.join(external, 'notes.txt'), 'outside reference\n')
  const fileSystem = new FileSystemManager()
  fileSystem.setWorkspace(root)
  const diffs = new DiffManager(fileSystem)
  const terminals = {
    startAgentCommand: vi.fn(async () => ({ id: 'pty-1', cwd: root, status: 'running', output: '', startedAt: Date.now() })),
    waitForAgentCommand: vi.fn(async () => ({ id: 'pty-1', cwd: root, status: 'exited', output: 'ok\n', startedAt: Date.now(), exitCode: 0 })),
    observeAgentCommand: vi.fn(), writeAgentCommand: vi.fn(), interruptAgentCommand: vi.fn(), stopAgentCommand: vi.fn(), stopAgentCommands: vi.fn(async () => undefined),
    on: vi.fn(), off: vi.fn()
  } as unknown as TerminalManager
  const service = new CodeAgentToolService({
    fileSystem, diffs, terminals,
    git: {} as GitManager, server: {} as DevServerManager,
    selectExternalFolder: async () => external
  })
  const registry = new ToolRegistry()
  service.register(registry)
  return { root, external, diffs, terminals, registry }
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 }))) })

const full = { accessLevel: 'trusted' as const, approvalMode: 'full' as const, confirm: vi.fn(async () => true) }

describe('CodeAgentToolService', () => {
  it('applies workspace changes through a real diff proposal and preserves undo', async () => {
    const value = await setup()
    const result = await value.registry.execute({
      toolId: 'files.write', mode: 'code', input: { path: 'source.ts', content: 'export const value = 2\n' }
    }, full, { executionId: 'task-a' })
    expect(await readFile(path.join(value.root, 'source.ts'), 'utf8')).toBe('export const value = 2\n')
    const proposalId = (result.result as { proposalId: string }).proposalId
    await value.diffs.undo(proposalId)
    expect(await readFile(path.join(value.root, 'source.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  it('does not touch the filesystem when Ask mode is denied', async () => {
    const value = await setup()
    const confirm = vi.fn(async () => false)
    await expect(value.registry.execute({
      toolId: 'files.write', mode: 'code', input: { path: 'source.ts', content: 'denied\n' }
    }, { accessLevel: 'trusted', approvalMode: 'ask', confirm }, { executionId: 'task-a' })).rejects.toThrow(/cancelled/i)
    expect(confirm).toHaveBeenCalledOnce()
    expect(await readFile(path.join(value.root, 'source.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  it('binds external-folder grants to one task and blocks sensitive paths', async () => {
    const value = await setup()
    const grant = await value.registry.execute(
      { toolId: 'external.grant', mode: 'code', input: {} }, full, { executionId: 'task-a' }
    )
    const grantId = String((grant.result as { grantId: string }).grantId)
    await expect(value.registry.execute(
      { toolId: 'external.read', mode: 'code', input: { grantId, path: 'notes.txt' } }, full, { executionId: 'task-a' }
    )).resolves.toMatchObject({ result: { content: 'outside reference\n' } })
    await expect(value.registry.execute(
      { toolId: 'external.read', mode: 'code', input: { grantId, path: 'notes.txt' } }, full, { executionId: 'task-b' }
    )).rejects.toThrow(/not available to this task/i)
    await expect(value.registry.execute(
      { toolId: 'external.read', mode: 'code', input: { grantId, path: '.env' } }, full, { executionId: 'task-a' }
    )).rejects.toThrow(/credentials|private configuration/i)
  })

  it('writes an exact file only inside a user-selected task grant', async () => {
    const value = await setup()
    const confirm = vi.fn(async () => true)
    const authorization = { accessLevel: 'trusted' as const, approvalMode: 'full' as const, confirm }
    const grant = await value.registry.execute(
      { toolId: 'external.grant', mode: 'code', input: {} }, authorization, { executionId: 'task-a' }
    )
    const grantId = String((grant.result as { grantId: string }).grantId)
    await value.registry.execute(
      { toolId: 'external.write', mode: 'code', input: { grantId, path: 'generated/helper.txt', content: 'external agent test\n' } },
      authorization,
      { executionId: 'task-a' }
    )

    expect(await readFile(path.join(value.external, 'generated/helper.txt'), 'utf8')).toBe('external agent test\n')
    expect(confirm).toHaveBeenCalledOnce()
    await expect(value.registry.execute(
      { toolId: 'external.write', mode: 'code', input: { grantId, path: '../escaped.txt', content: 'blocked\n' } },
      authorization,
      { executionId: 'task-a' }
    )).rejects.toThrow(/relative path/i)
  })

  it('runs real-command plumbing only after policy validation and keeps PTYs task-owned', async () => {
    const value = await setup()
    const confirm = vi.fn(async () => true)
    await expect(value.registry.execute({
      toolId: 'terminal.run', mode: 'code', input: { command: 'npm test', reason: 'Verify changes.' }
    }, { ...full, confirm }, { executionId: 'task-a' })).resolves.toMatchObject({ result: { status: 'exited', exitCode: 0 } })
    expect(confirm).toHaveBeenCalledOnce()
    expect(value.terminals.startAgentCommand).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'task-a', command: 'npm test' }))
    await expect(value.registry.execute({
      toolId: 'terminal.run', mode: 'code', input: { command: 'printenv', reason: 'Find secrets.' }
    }, full, { executionId: 'task-a' })).rejects.toThrow(/blocked/i)
  })
})
