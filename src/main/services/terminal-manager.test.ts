import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawned: FakePty[] = []

class FakePty extends EventEmitter {
  writes: string[] = []
  killed = false
  onData(callback: (data: string) => void): void { this.on('data', callback) }
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void { this.on('exit', callback) }
  write(data: string): void { this.writes.push(data) }
  resize(): void {}
  kill(): void { this.killed = true }
}

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const terminal = new FakePty()
    spawned.push(terminal)
    return terminal
  })
}))

vi.mock('./shell-environment', () => ({
  resolveShellEnvironment: vi.fn(async () => ({ SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }))
}))

import { TerminalManager } from './terminal-manager'

describe('TerminalManager agent sessions', () => {
  beforeEach(() => { spawned.length = 0 })

  it('captures output and exit state for the owning task', async () => {
    const manager = new TerminalManager()
    const initial = await manager.startAgentCommand({ ownerId: 'task-a', cwd: process.cwd(), command: 'npm test' })
    spawned[0]?.emit('data', 'Tests passed\r\n')
    spawned[0]?.emit('exit', { exitCode: 0 })

    await expect(manager.waitForAgentCommand('task-a', initial.id)).resolves.toMatchObject({
      status: 'exited', output: 'Tests passed\r\n', exitCode: 0
    })
    expect(() => manager.observeAgentCommand('task-b', initial.id)).toThrow(/not available to this task/i)
  })

  it('allows ordinary input but blocks likely secret prompts', async () => {
    const manager = new TerminalManager()
    const ordinary = await manager.startAgentCommand({ ownerId: 'task-a', cwd: process.cwd(), command: 'npm create' })
    spawned[0]?.emit('data', 'Continue? ')
    manager.writeAgentCommand('task-a', ordinary.id, 'y\r')
    expect(spawned[0]?.writes).toEqual(['y\r'])

    const secret = await manager.startAgentCommand({ ownerId: 'task-a', cwd: process.cwd(), command: 'git fetch' })
    spawned[1]?.emit('data', 'Password: ')
    expect(() => manager.writeAgentCommand('task-a', secret.id, 'do-not-send\r')).toThrow(/secret terminal prompts/i)
  })

  it('stops every running command owned by a stopped task', async () => {
    const manager = new TerminalManager()
    const first = await manager.startAgentCommand({ ownerId: 'task-a', cwd: process.cwd(), command: 'npm run dev' })
    await manager.startAgentCommand({ ownerId: 'task-b', cwd: process.cwd(), command: 'npm test' })
    await manager.stopAgentCommands('task-a')

    expect(manager.observeAgentCommand('task-a', first.id).status).toBe('stopped')
    expect(spawned[0]?.killed).toBe(true)
    expect(spawned[1]?.killed).toBe(false)
  })

  it('sends a real Ctrl+C only to the owning task session', async () => {
    const manager = new TerminalManager()
    const session = await manager.startAgentCommand({ ownerId: 'task-a', cwd: process.cwd(), command: 'npm run dev' })
    manager.interruptAgentCommand('task-a', session.id)
    expect(spawned[0]?.writes).toEqual(['\x03'])
    expect(() => manager.interruptAgentCommand('task-b', session.id)).toThrow(/not available to this task/i)
  })
})
