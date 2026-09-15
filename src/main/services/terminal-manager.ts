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

export type AgentTerminalStatus = 'running' | 'exited' | 'stopped'

export interface AgentTerminalSnapshot {
  id: string
  cwd: string
  status: AgentTerminalStatus
  output: string
  startedAt: number
  completedAt?: number
  exitCode?: number
  signal?: number
}

interface ManagedAgentTerminal extends AgentTerminalSnapshot {
  ownerId: string
  process: pty.IPty
  waiters: Set<() => void>
}

const AGENT_OUTPUT_LIMIT = 64 * 1024
const AGENT_SESSION_LIMIT = 64
const SENSITIVE_PROMPT = /(?:password|passphrase|private\s+key|access\s+token|api[_ -]?key|secret)\s*[:?]\s*$/iu

function boundedOutput(previous: string, next: string): string {
  const combined = `${previous}${next}`
  return combined.length > AGENT_OUTPUT_LIMIT ? combined.slice(-AGENT_OUTPUT_LIMIT) : combined
}

export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, ManagedTerminal>()
  private agentSessions = new Map<string, ManagedAgentTerminal>()

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

  async startAgentCommand(options: { ownerId: string; cwd: string; command: string }): Promise<AgentTerminalSnapshot> {
    if (typeof options.ownerId !== 'string' || !options.ownerId.trim() || options.ownerId.length > 160) throw new Error('The terminal task identity is invalid.')
    if (typeof options.command !== 'string' || !options.command.trim() || options.command.length > 2_000 || options.command.includes('\0')) {
      throw new Error('The terminal command is invalid.')
    }
    const cwd = path.resolve(options.cwd)
    if (!existsSync(cwd)) throw new Error('The terminal working directory no longer exists.')
    const shells = await this.listShells()
    const shell = shells.find((candidate) => path.basename(candidate) === 'zsh') ?? shells[0] ?? '/bin/zsh'
    const processEnvironment = Object.fromEntries(
      Object.entries(await resolveShellEnvironment()).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
    processEnvironment.TERM = 'xterm-256color'
    processEnvironment.COLORTERM = 'truecolor'
    processEnvironment.TERM_PROGRAM = 'OmniCode-Agent'
    const args = ['-l', '-c', options.command.trim()]
    const terminalProcess = pty.spawn(shell, args, {
      name: 'xterm-256color', cols: 120, rows: 40, cwd, env: processEnvironment
    })
    const id = randomUUID()
    const session: ManagedAgentTerminal = {
      id,
      ownerId: options.ownerId.trim(),
      cwd,
      status: 'running',
      output: '',
      startedAt: Date.now(),
      process: terminalProcess,
      waiters: new Set()
    }
    this.agentSessions.set(id, session)
    terminalProcess.onData((data) => {
      session.output = boundedOutput(session.output, data)
      this.emit('agent-data', { ownerId: session.ownerId, id, data })
    })
    terminalProcess.onExit(({ exitCode, signal }) => {
      if (session.status === 'running') session.status = 'exited'
      session.exitCode = exitCode
      session.signal = signal
      session.completedAt = Date.now()
      for (const wake of session.waiters) wake()
      session.waiters.clear()
      this.pruneAgentSessions()
      this.emit('agent-exit', { ownerId: session.ownerId, id, exitCode, signal })
    })
    return this.agentSnapshot(session)
  }

  observeAgentCommand(ownerId: string, id: string): AgentTerminalSnapshot {
    return this.agentSnapshot(this.agentSession(ownerId, id))
  }

  writeAgentCommand(ownerId: string, id: string, data: string): void {
    const session = this.agentSession(ownerId, id)
    if (session.status !== 'running') throw new Error('That agent terminal command has already finished.')
    if (typeof data !== 'string' || !data.length || data.length > 8_192 || data.includes('\0')) throw new Error('Agent terminal input is invalid or too large.')
    const visibleTail = session.output.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/gu, '').slice(-500).trimEnd()
    if (SENSITIVE_PROMPT.test(visibleTail)) throw new Error('Secret terminal prompts require the user to take over in a regular terminal.')
    session.process.write(data)
  }

  interruptAgentCommand(ownerId: string, id: string): void {
    const session = this.agentSession(ownerId, id)
    if (session.status !== 'running') throw new Error('That agent terminal command has already finished.')
    session.process.write('\x03')
  }

  async waitForAgentCommand(ownerId: string, id: string, signal?: AbortSignal): Promise<AgentTerminalSnapshot> {
    const session = this.agentSession(ownerId, id)
    if (session.status !== 'running') return this.agentSnapshot(session)
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        session.waiters.delete(wake)
        reject(signal?.reason ?? new DOMException('Terminal wait cancelled.', 'AbortError'))
      }
      session.waiters.add(wake)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
    return this.agentSnapshot(session)
  }

  async stopAgentCommand(ownerId: string, id: string): Promise<AgentTerminalSnapshot> {
    const session = this.agentSession(ownerId, id)
    if (session.status === 'running') {
      session.status = 'stopped'
      session.completedAt = Date.now()
      session.process.kill()
      for (const wake of session.waiters) wake()
      session.waiters.clear()
    }
    return this.agentSnapshot(session)
  }

  async stopAgentCommands(ownerId: string): Promise<void> {
    const owned = [...this.agentSessions.values()].filter((session) => session.ownerId === ownerId && session.status === 'running')
    await Promise.all(owned.map((session) => this.stopAgentCommand(ownerId, session.id)))
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
    for (const session of this.agentSessions.values()) if (session.status === 'running') session.process.kill()
    this.sessions.clear()
    this.agentSessions.clear()
  }

  private toInfo(session: ManagedTerminal): TerminalSessionInfo {
    return { id: session.id, name: session.name, shell: session.shell, cwd: session.cwd }
  }

  private agentSession(ownerId: string, id: string): ManagedAgentTerminal {
    const session = this.agentSessions.get(id)
    if (!session || session.ownerId !== ownerId) throw new Error('That agent terminal command is not available to this task.')
    return session
  }

  private agentSnapshot(session: ManagedAgentTerminal): AgentTerminalSnapshot {
    return {
      id: session.id,
      cwd: session.cwd,
      status: session.status,
      output: session.output,
      startedAt: session.startedAt,
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {})
    }
  }

  private pruneAgentSessions(): void {
    if (this.agentSessions.size <= AGENT_SESSION_LIMIT) return
    const completed = [...this.agentSessions.values()]
      .filter((session) => session.status !== 'running')
      .sort((left, right) => (left.completedAt ?? left.startedAt) - (right.completedAt ?? right.startedAt))
    for (const session of completed.slice(0, this.agentSessions.size - AGENT_SESSION_LIMIT)) this.agentSessions.delete(session.id)
  }
}
