import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import * as pty from 'node-pty'
import type { TerminalDataEvent, TerminalExitEvent, TerminalSessionInfo } from '../../shared/contracts'
import { resolveShellEnvironment } from './shell-environment'

interface ManagedTerminal extends TerminalSessionInfo {
  process: pty.IPty
}

export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, ManagedTerminal>()

  async listShells(): Promise<string[]> {
    const environment = await resolveShellEnvironment()
    const systemShells = await readFile('/etc/shells', 'utf8')
      .then((value) => value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith('/')))
      .catch(() => [])
    const candidates = [
      environment.SHELL,
      '/bin/zsh',
      '/bin/bash',
      '/opt/homebrew/bin/fish',
      '/usr/local/bin/fish',
      '/bin/sh',
      ...systemShells
    ]
    return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate && existsSync(candidate))))]
  }

  async create(options: { cwd: string; shell?: string; name?: string }): Promise<TerminalSessionInfo> {
    const shells = await this.listShells()
    const shell = options.shell && shells.includes(options.shell) ? options.shell : shells[0] ?? '/bin/zsh'
    const cwd = path.resolve(options.cwd)
    if (!existsSync(cwd)) throw new Error('The terminal working directory no longer exists.')
    const id = randomUUID()
    const args = path.basename(shell) === 'zsh' || path.basename(shell) === 'bash' ? ['-l'] : []
    const processEnvironment = Object.fromEntries(
      Object.entries(await resolveShellEnvironment()).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
    processEnvironment.TERM = 'xterm-256color'
    processEnvironment.COLORTERM = 'truecolor'
    processEnvironment.TERM_PROGRAM = 'OmniCode'

    const terminalProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: processEnvironment
    })
    const session: ManagedTerminal = {
      id,
      name: options.name?.trim().slice(0, 80) || path.basename(shell),
      shell,
      cwd,
      process: terminalProcess
    }
    this.sessions.set(id, session)
    terminalProcess.onData((data) => this.emit('data', { id, data } satisfies TerminalDataEvent))
    terminalProcess.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id)
      this.emit('exit', { id, exitCode, signal } satisfies TerminalExitEvent)
    })
    return this.toInfo(session)
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (typeof data !== 'string' || data.length > 1024 * 1024) throw new Error('Terminal input is invalid or too large.')
    session.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.process.resize(Math.min(1_000, Math.max(2, Math.floor(cols))), Math.min(500, Math.max(1, Math.floor(rows))))
  }

  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    session.process.kill()
    this.sessions.delete(id)
  }

  async restart(id: string): Promise<TerminalSessionInfo> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('That terminal session is no longer available.')
    const options = { cwd: session.cwd, shell: session.shell, name: session.name }
    await this.kill(id)
    return this.create(options)
  }

  shutdown(): void {
    for (const session of this.sessions.values()) session.process.kill()
    this.sessions.clear()
  }

  private toInfo(session: ManagedTerminal): TerminalSessionInfo {
    return { id: session.id, name: session.name, shell: session.shell, cwd: session.cwd }
  }
}
