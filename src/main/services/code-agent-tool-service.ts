import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { JsonValue, ToolDescriptor } from '../../shared/tool-contracts'
import type { FileSystemManager } from './filesystem-manager'
import { isPathInside } from './filesystem-manager'
import type { DiffManager } from './diff-manager'
import type { GitManager } from './git-manager'
import type { DevServerManager } from './dev-server-manager'
import type { TerminalManager } from './terminal-manager'
import { validateAgentCommand, validateDependencyCommand } from './agent-command-policy'
import { isSensitiveRelativePath, isSensitiveWorkspacePath } from './sensitive-paths'
import { redactCodeAgentText } from './code-agent-activity-manager'
import { detectTools } from './runtime-manager'
import { ToolRegistry, type ToolExecutorContext } from './tool-registry'
import type { CodeApplicationManager } from './code-application-manager'

const MAX_AGENT_FILE_CONTENT = 60 * 1024
const MAX_AGENT_READ_CONTENT = 192 * 1024
const MAX_DIRECTORY_ENTRIES = 500
const MAX_SEARCH_RESULTS = 200

type ToolRegistration = { descriptor: ToolDescriptor; execute: Parameters<ToolRegistry['register']>[1] }

interface ExternalGrant {
  id: string
  root: string
  label: string
}

export interface CodeAgentToolServiceOptions {
  fileSystem: FileSystemManager
  diffs: DiffManager
  terminals: TerminalManager
  git: GitManager
  server: DevServerManager
  applications?: CodeApplicationManager
  selectExternalFolder?(): Promise<string | null>
  activateWorkspace?(root: string): Promise<void>
  focusBehavior?(taskId: string): 'automatic' | 'when-needed' | 'never'
}

function relativeInput(value: JsonValue | undefined, label = 'path', allowRoot = false): string {
  if (typeof value !== 'string') throw new Error(`The ${label} is invalid.`)
  const normalized = value.trim().replaceAll('\\', '/')
  if (allowRoot && normalized === '.') return ''
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new Error(`The ${label} must be a relative path inside the approved root.`)
  }
  if (isSensitiveRelativePath(normalized)) throw new Error(`The ${label} is blocked because it may contain credentials or private configuration.`)
  return normalized
}

function owner(context: ToolExecutorContext): string {
  if (!context.executionId) throw new Error('This Code tool is not attached to an active task.')
  return context.executionId
}

function text(value: JsonValue | undefined, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new Error(`The ${label} is invalid.`)
  return value
}

function optionalInteger(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function readSafety(): Pick<ToolDescriptor, 'action' | 'category' | 'risk' | 'reversible' | 'externalSideEffect' | 'confirmation' | 'requiredScopes'> {
  return { action: 'read', category: 'read', risk: 'low', reversible: true, externalSideEffect: false, confirmation: 'never', requiredScopes: [] }
}

function workspacePath(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath)
  if (!isPathInside(root, target) || isSensitiveWorkspacePath(root, target)) throw new Error('The requested file is outside the workspace or contains sensitive configuration.')
  return target
}

function cleanTerminalOutput(value: string): string {
  return redactCodeAgentText(value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/gu, ''), MAX_AGENT_READ_CONTENT)
}

function resultSummary(proposal: Awaited<ReturnType<DiffManager['accept']>>): Record<string, JsonValue> {
  return {
    proposalId: proposal.id,
    status: proposal.status,
    files: proposal.files.map((file) => ({
      path: file.relativePath, kind: file.kind, additions: file.additions, deletions: file.deletions
    }))
  }
}

export class CodeAgentToolService {
  readonly #grants = new Map<string, Map<string, ExternalGrant>>()
  #serverOwner: string | null = null

  constructor(private readonly options: CodeAgentToolServiceOptions) {}

  register(registry: ToolRegistry): void {
    for (const tool of this.registrations()) registry.register(tool.descriptor, tool.execute)
  }

  async cleanupTask(taskId: string): Promise<void> {
    await this.options.terminals.stopAgentCommands(taskId)
    this.#grants.delete(taskId)
    if (this.#serverOwner === taskId) {
      await this.options.server.stop().catch(() => undefined)
      this.#serverOwner = null
    }
  }

  private registrations(): ToolRegistration[] {
    const workspace = (): string => {
      const root = this.options.fileSystem.getWorkspace()
      if (!root) throw new Error('Open a workspace before using Code Agent tools.')
      return root
    }
    const base = (id: string, name: string, description: string, connectorId: string): Omit<ToolDescriptor, 'action' | 'category' | 'risk' | 'reversible' | 'externalSideEffect' | 'confirmation' | 'requiredScopes' | 'inputSchema'> => ({
      id, name, description, connectorId, modes: ['code']
    })
    const read = readSafety()
    const entries: ToolRegistration[] = []
    entries.push({
      descriptor: {
        ...base('files.list', 'List directory', 'List one workspace directory without recursively loading the project.', 'files'), ...read,
        inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 1_024 } }, additionalProperties: false }, maxResultBytes: 128 * 1024
      },
      execute: async (input) => {
        const root = workspace()
        const relative = typeof input.path === 'string' && input.path.trim() ? relativeInput(input.path) : ''
        const directory = relative ? workspacePath(root, relative) : root
        const values = await fs.readdir(this.options.fileSystem.resolveAuthorizedPath(directory), { withFileTypes: true })
        return {
          path: relative || '.',
          entries: values.filter((entry) => !isSensitiveRelativePath(relative ? `${relative}/${entry.name}` : entry.name)).slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
          truncated: values.length > MAX_DIRECTORY_ENTRIES
        }
      }
    })
    entries.push({
      descriptor: {
        ...base('files.read', 'Read file', 'Read a bounded UTF-8 text file in the current workspace.', 'files'), ...read,
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1_024 } }, required: ['path'], additionalProperties: false }, maxResultBytes: 256 * 1024
      },
      execute: async (input) => {
        const root = workspace()
        const relative = relativeInput(input.path)
        const document = await this.options.fileSystem.readFile(workspacePath(root, relative))
        return { path: relative, content: document.content.slice(0, MAX_AGENT_READ_CONTENT), truncated: document.content.length > MAX_AGENT_READ_CONTENT, modifiedAt: document.modifiedAt }
      }
    })
    entries.push({
      descriptor: {
        ...base('files.search', 'Search workspace', 'Search text across the current workspace with normal ignored-directory rules.', 'files'), ...read,
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1_000 } }, required: ['query'], additionalProperties: false }, maxResultBytes: 256 * 1024
      },
      execute: async (input) => {
        const root = workspace()
        const matches = await this.options.fileSystem.search(root, text(input.query, 'search query', 1_000))
        return { matches: matches.slice(0, MAX_SEARCH_RESULTS).filter((match) => !isSensitiveWorkspacePath(root, match.path)).map((match) => ({ path: path.relative(root, match.path), line: match.line, column: match.column, preview: match.preview.slice(0, 1_000) })), truncated: matches.length > MAX_SEARCH_RESULTS }
      }
    })
    const fileWrite = { action: 'write' as const, category: 'write' as const, risk: 'low' as const, reversible: true, externalSideEffect: false, confirmation: 'policy' as const, requiredScopes: [] }
    entries.push({
      descriptor: {
        ...base('files.write', 'Write workspace file', 'Create or replace one workspace text file through the reviewable diff and undo system.', 'files'), ...fileWrite,
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1_024 }, content: { type: 'string', maxLength: MAX_AGENT_FILE_CONTENT } }, required: ['path', 'content'], additionalProperties: false }
      },
      execute: async (input) => {
        const root = workspace()
        const relative = relativeInput(input.path)
        const target = workspacePath(root, relative)
        const exists = await fs.stat(target).then((stat) => stat.isFile()).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error))
        const proposal = await this.options.diffs.propose({ workspaceRoot: root, title: `Code Agent: ${exists ? 'Update' : 'Create'} ${relative}`, changes: [{ kind: exists ? 'modify' : 'create', path: relative, content: String(input.content ?? '') }] })
        return resultSummary(await this.options.diffs.accept(proposal.id, { scope: 'all' }))
      }
    })
    entries.push({
      descriptor: {
        ...base('files.delete', 'Delete workspace file', 'Delete one workspace text file through the reviewable diff and undo system.', 'files'),
        action: 'destructive', category: 'destructive', risk: 'medium', reversible: true, externalSideEffect: false, confirmation: 'policy', requiredScopes: [],
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1_024 } }, required: ['path'], additionalProperties: false }
      },
      execute: async (input) => {
        const root = workspace()
        const relative = relativeInput(input.path)
        const proposal = await this.options.diffs.propose({ workspaceRoot: root, title: `Code Agent: Delete ${relative}`, changes: [{ kind: 'delete', path: relative }] })
        return resultSummary(await this.options.diffs.accept(proposal.id, { scope: 'all' }))
      }
    })

    const terminalBase = { action: 'write' as const, category: 'system' as const, risk: 'high' as const, reversible: false, externalSideEffect: false, confirmation: 'policy' as const, requiredScopes: [] }
    entries.push({
      descriptor: {
        ...base('terminal.run', 'Run terminal command', 'Run one reviewed command in a real login-shell PTY and wait for its exit.', 'terminal'), ...terminalBase,
        inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 2_000 }, reason: { type: 'string', minLength: 1, maxLength: 1_000 } }, required: ['command', 'reason'], additionalProperties: false }, timeoutMs: 120_000, maxResultBytes: 256 * 1024
      },
      execute: async (input, context) => {
        const taskId = owner(context)
        const command = validateAgentCommand(input.command, input.reason).command
        return this.runCommand(taskId, workspace(), command, context)
      }
    })
    for (const purpose of ['build', 'test'] as const) entries.push({
      descriptor: {
        ...base(`${purpose}.run`, `Run project ${purpose}`, `Run one reviewed ${purpose} command in the workspace and return its real output and exit code.`, purpose), ...terminalBase,
        inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 2_000 }, reason: { type: 'string', minLength: 1, maxLength: 1_000 } }, required: ['command', 'reason'], additionalProperties: false }, timeoutMs: 120_000, maxResultBytes: 256 * 1024
      },
      execute: async (input, context) => {
        const taskId = owner(context)
        const command = validateAgentCommand(input.command, input.reason).command
        return this.runCommand(taskId, workspace(), command, context)
      }
    })
    entries.push({
      descriptor: {
        ...base('dependency.install', 'Install project dependencies', 'Run one allowlisted project dependency command after direct user approval.', 'dependency'),
        action: 'write', category: 'system', risk: 'critical', reversible: false, externalSideEffect: true, confirmation: 'always', requiredScopes: [],
        inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 2_000 }, reason: { type: 'string', minLength: 1, maxLength: 1_000 } }, required: ['command', 'reason'], additionalProperties: false }, timeoutMs: 120_000, maxResultBytes: 256 * 1024
      },
      execute: async (input, context) => {
        const taskId = owner(context)
        const command = validateDependencyCommand(input.command, input.reason).command
        return this.runCommand(taskId, workspace(), command, context)
      }
    })
    entries.push({
      descriptor: {
        ...base('terminal.start', 'Start terminal command', 'Start a long-running command in a task-owned login-shell PTY.', 'terminal'), ...terminalBase,
        inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 2_000 }, reason: { type: 'string', minLength: 1, maxLength: 1_000 } }, required: ['command', 'reason'], additionalProperties: false }
      },
      execute: async (input, context) => {
        const command = validateAgentCommand(input.command, input.reason).command
        const started = await this.options.terminals.startAgentCommand({ ownerId: owner(context), cwd: workspace(), command })
        return { sessionId: started.id, status: started.status }
      }
    })
    entries.push({
      descriptor: {
        ...base('terminal.observe', 'Observe terminal command', 'Read bounded output and status from a task-owned terminal command.', 'terminal'), ...read,
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['sessionId'], additionalProperties: false }, maxResultBytes: 256 * 1024
      },
      execute: async (input, context) => {
        const snapshot = this.options.terminals.observeAgentCommand(owner(context), String(input.sessionId))
        return { sessionId: snapshot.id, status: snapshot.status, output: cleanTerminalOutput(snapshot.output), exitCode: snapshot.exitCode ?? -1 }
      }
    })
    entries.push({
      descriptor: {
        ...base('terminal.input', 'Send terminal input', 'Send non-secret input to a task-owned interactive command.', 'terminal'), ...terminalBase,
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1, maxLength: 128 }, input: { type: 'string', minLength: 1, maxLength: 8_192 } }, required: ['sessionId', 'input'], additionalProperties: false }
      },
      execute: async (input, context) => { this.options.terminals.writeAgentCommand(owner(context), String(input.sessionId), String(input.input)); return { sent: true } }
    })
    entries.push({
      descriptor: {
        ...base('terminal.stop', 'Stop terminal command', 'Stop one task-owned terminal command.', 'terminal'),
        action: 'write', category: 'system', risk: 'low', reversible: true, externalSideEffect: false, confirmation: 'never', requiredScopes: [],
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['sessionId'], additionalProperties: false }
      },
      execute: async (input, context) => {
        const stopped = await this.options.terminals.stopAgentCommand(owner(context), String(input.sessionId))
        return { sessionId: stopped.id, status: stopped.status, output: cleanTerminalOutput(stopped.output), exitCode: stopped.exitCode ?? -1 }
      }
    })
    entries.push({
      descriptor: {
        ...base('terminal.interrupt', 'Interrupt terminal command', 'Send Ctrl+C to one task-owned interactive command.', 'terminal'),
        action: 'write', category: 'system', risk: 'low', reversible: true, externalSideEffect: false, confirmation: 'never', requiredScopes: [],
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['sessionId'], additionalProperties: false }
      },
      execute: async (input, context) => { this.options.terminals.interruptAgentCommand(owner(context), String(input.sessionId)); return { interrupted: true } }
    })

    entries.push({
      descriptor: { ...base('git.status', 'Read Git status', 'Read the actual Git branch and changed-file state.', 'git'), ...read, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      execute: async () => this.options.git.status(workspace()) as unknown as JsonValue
    })
    entries.push({
      descriptor: {
        ...base('git.diff', 'Read Git diff', 'Read a bounded working-tree or staged Git diff.', 'git'), ...read,
        inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 1_024 }, staged: { type: 'boolean' } }, additionalProperties: false }, maxResultBytes: 256 * 1024
      },
      execute: async (input) => {
        const relative = typeof input.path === 'string' && input.path.trim() ? relativeInput(input.path) : undefined
        const value = await this.options.git.diff(workspace(), relative, input.staged === true)
        return { diff: redactCodeAgentText(value, MAX_AGENT_READ_CONTENT), truncated: value.length > MAX_AGENT_READ_CONTENT }
      }
    })
    const gitWrite = { action: 'write' as const, category: 'write' as const, risk: 'medium' as const, reversible: true, externalSideEffect: false, confirmation: 'policy' as const, requiredScopes: [] }
    for (const operation of ['stage', 'unstage'] as const) entries.push({
      descriptor: {
        ...base(`git.${operation}`, `${operation === 'stage' ? 'Stage' : 'Unstage'} Git files`, `${operation === 'stage' ? 'Stage' : 'Unstage'} exact relative workspace paths.`, 'git'), ...gitWrite,
        inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 1_024 }, minItems: 1, maxItems: 100 } }, required: ['paths'], additionalProperties: false }
      },
      execute: async (input) => {
        const paths = (input.paths as JsonValue[]).map((value) => relativeInput(value))
        await this.options.git[operation](workspace(), paths)
        return { changed: paths.length }
      }
    })
    entries.push({
      descriptor: {
        ...base('git.commit', 'Create Git commit', 'Create a local Git commit from the currently staged changes.', 'git'), ...gitWrite,
        inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 10_000 } }, required: ['message'], additionalProperties: false }, maxResultBytes: 64 * 1024
      },
      execute: async (input) => ({ output: redactCodeAgentText(await this.options.git.commit(workspace(), String(input.message)), 32 * 1024) })
    })
    for (const operation of ['init', 'fetch', 'pull', 'push'] as const) {
      const remote = operation !== 'init'
      entries.push({
        descriptor: {
          ...base(`git.${operation}`, `${operation[0]?.toUpperCase()}${operation.slice(1)} Git repository`, `Run the structured Git ${operation} operation and report its actual result.`, 'git'),
          action: 'write', category: remote ? 'external-submission' : 'write', risk: operation === 'push' ? 'high' : 'medium', reversible: operation !== 'push', externalSideEffect: remote, confirmation: 'policy', requiredScopes: [],
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, maxResultBytes: 64 * 1024
        },
        execute: async () => ({ output: redactCodeAgentText(await this.options.git.operation(workspace(), operation), 32 * 1024) })
      })
    }

    entries.push({
      descriptor: { ...base('server.detect', 'Detect development servers', 'Read runnable development-server options from the workspace.', 'server'), ...read, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      execute: async () => await this.options.server.detect(workspace()) as unknown as JsonValue
    })
    entries.push({
      descriptor: {
        ...base('server.start', 'Start development server', 'Start the existing static or package development server for this workspace.', 'server'),
        action: 'write', category: 'system', risk: 'medium', reversible: true, externalSideEffect: false, confirmation: 'policy', requiredScopes: [], timeoutMs: 60_000,
        inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['static', 'package'] }, script: { type: 'string', maxLength: 200 }, port: { type: 'integer', minimum: 0, maximum: 65_535 } }, required: ['kind'], additionalProperties: false }
      },
      execute: async (input, context) => {
        const taskId = owner(context)
        if (this.#serverOwner && this.#serverOwner !== taskId) throw new Error('Another Code Agent task owns the running development server.')
        const state = input.kind === 'package'
          ? await this.options.server.startProject(workspace(), text(input.script, 'server script', 200), optionalInteger(input.port, 0) || undefined)
          : await this.options.server.start(workspace(), optionalInteger(input.port, 0))
        this.#serverOwner = taskId
        return state as unknown as JsonValue
      }
    })
    entries.push({
      descriptor: { ...base('server.status', 'Read server status', 'Read the actual current development-server state.', 'server'), ...read, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      execute: async () => this.options.server.state() as unknown as JsonValue
    })
    entries.push({
      descriptor: {
        ...base('server.stop', 'Stop development server', 'Stop the development server owned by this Code Agent task.', 'server'),
        action: 'write', category: 'system', risk: 'low', reversible: true, externalSideEffect: false, confirmation: 'never', requiredScopes: [], inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      execute: async (_input, context) => {
        if (this.#serverOwner && this.#serverOwner !== owner(context)) throw new Error('This task does not own the running development server.')
        const state = await this.options.server.stop(); this.#serverOwner = null; return state as unknown as JsonValue
      }
    })
    entries.push({
      descriptor: {
        ...base('runtime.detect', 'Detect development tools', 'Detect installed runtimes and compilers using real executable probes.', 'runtime'), ...read,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, maxResultBytes: 256 * 1024
      },
      execute: async () => (await detectTools()).map((tool) => ({ id: tool.id, name: tool.name, installed: tool.installed, path: tool.path ?? '', version: tool.version ?? '', guidance: tool.guidance ?? '' })) as unknown as JsonValue
    })

    if (this.options.applications) {
      entries.push({
        descriptor: { ...base('app.list', 'List development apps', 'List the fixed allowlist of applications Code Agent can launch.', 'app'), ...read, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        execute: async () => this.options.applications?.list() as unknown as JsonValue
      })
      entries.push({
        descriptor: { ...base('app.permissions', 'Read macOS permissions', 'Read Accessibility and Screen Recording authorization state without requesting access.', 'app'), ...read, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        execute: async () => this.options.applications?.permissions() as unknown as JsonValue
      })
      entries.push({
        descriptor: {
          ...base('app.launch', 'Launch development app', 'Launch one allowlisted macOS development application, optionally with a workspace path.', 'app'),
          action: 'write', category: 'system', risk: 'medium', reversible: true, externalSideEffect: false, confirmation: 'policy', requiredScopes: [],
          inputSchema: { type: 'object', properties: { application: { type: 'string', enum: ['safari', 'chrome', 'finder', 'terminal', 'simulator', 'xcode', 'preview', 'textedit'] }, path: { type: 'string', maxLength: 1_024 } }, required: ['application'], additionalProperties: false }
        },
        execute: async (input, context) => this.options.applications?.launch(
          String(input.application), workspace(),
          typeof input.path === 'string' && input.path ? relativeInput(input.path) : undefined,
          this.options.focusBehavior?.(owner(context)) === 'never'
        ) as unknown as JsonValue
      })
      entries.push({
        descriptor: {
          ...base('app.open-permissions', 'Open macOS permission settings', 'Open the exact System Settings privacy pane for a missing permission.', 'app'),
          action: 'write', category: 'system', risk: 'medium', reversible: true, externalSideEffect: false, confirmation: 'policy', requiredScopes: [],
          inputSchema: { type: 'object', properties: { permission: { type: 'string', enum: ['accessibility', 'screen-recording'] } }, required: ['permission'], additionalProperties: false }
        },
        execute: async (input) => { await this.options.applications?.openPermissionSettings(String(input.permission) as 'accessibility' | 'screen-recording'); return { opened: true } }
      })
    }

    entries.push(...this.externalRegistrations(base, read))
    return entries
  }

  private externalRegistrations(
    base: (id: string, name: string, description: string, connectorId: string) => Omit<ToolDescriptor, 'action' | 'category' | 'risk' | 'reversible' | 'externalSideEffect' | 'confirmation' | 'requiredScopes' | 'inputSchema'>,
    read: ReturnType<typeof readSafety>
  ): ToolRegistration[] {
    if (!this.options.selectExternalFolder) return []
    const inputSchema = (write = false): ToolDescriptor['inputSchema'] => ({
      type: 'object', properties: {
        grantId: { type: 'string', minLength: 1, maxLength: 128 },
        path: { type: 'string', minLength: 1, maxLength: 1_024 },
        ...(write ? { content: { type: 'string' as const, maxLength: MAX_AGENT_FILE_CONTENT } } : {})
      }, required: write ? ['grantId', 'path', 'content'] : ['grantId', 'path'], additionalProperties: false
    })
    const registrations: ToolRegistration[] = [{
      descriptor: {
        ...base('external.grant', 'Choose external folder', 'Ask the user to choose one exact folder outside the workspace for this task.', 'external'),
        action: 'sensitive', category: 'system', risk: 'high', reversible: true, externalSideEffect: false, confirmation: 'always', requiredScopes: [], inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      execute: async (_input, context) => {
        const root = await this.options.selectExternalFolder?.()
        if (!root) {
          const denied: Record<string, JsonValue> = { granted: false }
          return denied
        }
        const canonical = await fs.realpath(root)
        if (['/', '/System', '/Library', '/private/etc', '/private/var/db', '/private/var/root', '/usr', '/bin', '/sbin'].some((blocked) => canonical === blocked || canonical.startsWith(`${blocked}/`))) throw new Error('System and private operating-system folders cannot be granted to Code Agent.')
        const taskGrants = this.#grants.get(owner(context)) ?? new Map<string, ExternalGrant>()
        const grant = { id: randomUUID(), root: canonical, label: path.basename(canonical) || 'Selected folder' }
        taskGrants.set(grant.id, grant); this.#grants.set(owner(context), taskGrants)
        const granted: Record<string, JsonValue> = { granted: true, grantId: grant.id, name: grant.label }
        return granted
      }
    }, {
      descriptor: { ...base('external.list', 'List external folder', 'List one directory within a user-selected external folder.', 'external'), ...read, inputSchema: inputSchema(false), maxResultBytes: 128 * 1024 },
      execute: async (input, context) => {
        const resolved = await this.externalPath(owner(context), String(input.grantId), relativeInput(input.path, 'path', true))
        const values = await fs.readdir(resolved.target, { withFileTypes: true })
        return {
          path: resolved.relative || '.',
          entries: values.filter((entry) => !isSensitiveRelativePath(`${resolved.relative}/${entry.name}`)).slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
          truncated: values.length > MAX_DIRECTORY_ENTRIES
        }
      }
    }, {
      descriptor: { ...base('external.read', 'Read external file', 'Read one bounded text file within a user-selected external folder.', 'external'), ...read, inputSchema: inputSchema(false), maxResultBytes: 256 * 1024 },
      execute: async (input, context) => {
        const { target, relative } = await this.externalPath(owner(context), String(input.grantId), relativeInput(input.path))
        const stat = await fs.stat(target)
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('The external path is not a supported text file.')
        const buffer = await fs.readFile(target)
        if (buffer.includes(0)) throw new Error('Binary external files are not exposed to the AI agent.')
        const content = buffer.toString('utf8')
        return { path: relative, content: content.slice(0, MAX_AGENT_READ_CONTENT), truncated: content.length > MAX_AGENT_READ_CONTENT }
      }
    }, {
      descriptor: {
        ...base('external.write', 'Write external file', 'Create or replace one text file inside a user-selected external folder.', 'external'),
        action: 'write', category: 'system', risk: 'high', reversible: false, externalSideEffect: false, confirmation: 'policy', requiredScopes: [], inputSchema: inputSchema(true)
      },
      execute: async (input, context) => {
        const { target, relative } = await this.externalPath(owner(context), String(input.grantId), relativeInput(input.path), true)
        await fs.mkdir(path.dirname(target), { recursive: true })
        const temporary = `${target}.omnicode-${randomUUID()}.tmp`
        try { await fs.writeFile(temporary, String(input.content ?? ''), { encoding: 'utf8', mode: 0o600 }); await fs.rename(temporary, target) }
        finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
        return { path: relative, written: true, bytes: Buffer.byteLength(String(input.content ?? ''), 'utf8') }
      }
    }, {
      descriptor: {
        ...base('external.mkdir', 'Create external folder', 'Create a folder tree inside a user-selected external folder.', 'external'),
        action: 'write', category: 'system', risk: 'high', reversible: false, externalSideEffect: false, confirmation: 'policy', requiredScopes: [], inputSchema: inputSchema(false)
      },
      execute: async (input, context) => {
        const { target, relative } = await this.externalPath(owner(context), String(input.grantId), relativeInput(input.path), true)
        await fs.mkdir(target, { recursive: true })
        return { path: relative, created: true }
      }
    }, {
      descriptor: {
        ...base('external.move', 'Move external item', 'Move one item between two paths inside the same user-selected external folder.', 'external'),
        action: 'write', category: 'system', risk: 'high', reversible: true, externalSideEffect: false, confirmation: 'policy', requiredScopes: [],
        inputSchema: { type: 'object', properties: { grantId: { type: 'string', minLength: 1, maxLength: 128 }, source: { type: 'string', minLength: 1, maxLength: 1_024 }, destination: { type: 'string', minLength: 1, maxLength: 1_024 } }, required: ['grantId', 'source', 'destination'], additionalProperties: false }
      },
      execute: async (input, context) => {
        const taskId = owner(context)
        const source = await this.externalPath(taskId, String(input.grantId), relativeInput(input.source, 'source path'))
        const destination = await this.externalPath(taskId, String(input.grantId), relativeInput(input.destination, 'destination path'), true)
        await fs.rename(source.target, destination.target)
        return { source: source.relative, destination: destination.relative, moved: true }
      }
    }]
    if (this.options.activateWorkspace) registrations.push({
      descriptor: {
        ...base('external.open-workspace', 'Open external project', 'Switch OmniCode to a folder inside the user-selected external root.', 'external'),
        action: 'write', category: 'system', risk: 'high', reversible: true, externalSideEffect: false, confirmation: 'always', requiredScopes: [], inputSchema: inputSchema(false)
      },
      execute: async (input, context) => {
        const resolved = await this.externalPath(owner(context), String(input.grantId), relativeInput(input.path, 'path', true))
        if (!(await fs.stat(resolved.target)).isDirectory()) throw new Error('Choose an external project folder to open.')
        await this.options.activateWorkspace?.(resolved.target)
        return { path: resolved.relative || '.', opened: true }
      }
    })
    return registrations
  }

  private async externalPath(taskId: string, grantId: string, relative: string, allowMissing = false): Promise<{ target: string; relative: string }> {
    const grant = this.#grants.get(taskId)?.get(grantId)
    if (!grant) throw new Error('That external-folder grant is not available to this task.')
    const target = path.resolve(grant.root, relative)
    if (!isPathInside(grant.root, target) || isSensitiveRelativePath(relative)) throw new Error('The external path is outside the selected folder or contains sensitive configuration.')
    let canonical: string
    if (allowMissing) {
      let cursor = target
      const missing: string[] = []
      while (true) {
        try {
          const existing = await fs.realpath(cursor)
          canonical = path.join(existing, ...missing.reverse())
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const parent = path.dirname(cursor)
          if (parent === cursor) throw error
          missing.push(path.basename(cursor))
          cursor = parent
        }
      }
    } else canonical = await fs.realpath(target)
    if (!isPathInside(grant.root, canonical)) throw new Error('The external path resolves outside the selected folder.')
    return { target: canonical, relative }
  }

  private async runCommand(taskId: string, cwd: string, command: string, context: ToolExecutorContext): Promise<Record<string, JsonValue>> {
    const started = await this.options.terminals.startAgentCommand({ ownerId: taskId, cwd, command })
    let lastProgress = 0
    const onData = (event: { ownerId?: string; id?: string }): void => {
      if (event.ownerId !== taskId || event.id !== started.id || Date.now() - lastProgress < 150) return
      lastProgress = Date.now()
      const snapshot = this.options.terminals.observeAgentCommand(taskId, started.id)
      context.reportProgress?.({ sessionId: snapshot.id, status: snapshot.status, output: cleanTerminalOutput(snapshot.output) })
    }
    this.options.terminals.on('agent-data', onData)
    try {
      const completed = await this.options.terminals.waitForAgentCommand(taskId, started.id, context.signal)
      return { sessionId: completed.id, status: completed.status, output: cleanTerminalOutput(completed.output), exitCode: completed.exitCode ?? -1 }
    } finally {
      this.options.terminals.off('agent-data', onData)
    }
  }
}
