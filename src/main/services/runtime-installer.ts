import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants, createWriteStream } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type {
  ToolInstallationProgress,
  ToolInstallationResult,
  ToolInstallationPhase
} from '../../shared/contracts'
import {
  HOMEBREW_PATHS,
  RUNTIME_TOOL_DEFINITIONS,
  detectRuntimeTool,
  type RuntimeToolId
} from './runtime-manager'
import { resolveShellEnvironment } from './shell-environment'

const HOMEBREW_INSTALLER_URL =
  'https://github.com/Homebrew/brew/releases/latest/download/Homebrew.pkg'
const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/Ollama.dmg'
const OLLAMA_URL = 'http://127.0.0.1:11434/api/version'
const INSTALL_TIMEOUT_MS = 60 * 60_000
const DOWNLOAD_LIMITS = {
  homebrew: 256 * 1024 * 1024,
  ollama: 2 * 1024 * 1024 * 1024
} as const
const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'ollama.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com'
])

const XCODE_COMMAND_LINE_TOOLS = new Set<RuntimeToolId>([
  'xcode-command-line-tools',
  'git',
  'clang',
  'clang++',
  'swift',
  'swiftc',
  'make'
])

interface HomebrewPackage {
  name: string
  cask?: boolean
}

const HOMEBREW_PACKAGES: Partial<Record<RuntimeToolId, HomebrewPackage>> = {
  python3: { name: 'python' },
  node: { name: 'node' },
  npm: { name: 'node' },
  yarn: { name: 'yarn' },
  pnpm: { name: 'pnpm' },
  bun: { name: 'oven-sh/bun/bun' },
  deno: { name: 'deno' },
  java: { name: 'temurin', cask: true },
  javac: { name: 'temurin', cask: true },
  dotnet: { name: 'dotnet-sdk', cask: true },
  rustc: { name: 'rust' },
  cargo: { name: 'rust' },
  go: { name: 'go' },
  ruby: { name: 'ruby' },
  php: { name: 'php' },
  lua: { name: 'lua' },
  kotlinc: { name: 'kotlin' },
  gradle: { name: 'gradle' },
  docker: { name: 'docker', cask: true },
  ollama: { name: 'ollama' },
  bash: { name: 'bash' },
  zsh: { name: 'zsh' },
  fish: { name: 'fish' }
}

export type RuntimeInstallationPlan =
  | { kind: 'homebrew-installer' }
  | { kind: 'xcode-command-line-tools'; executable: '/usr/bin/xcode-select'; args: ['--install'] }
  | { kind: 'homebrew-package'; packageName: string; cask: boolean }

const TOOL_IDS = new Set<string>(RUNTIME_TOOL_DEFINITIONS.map(({ id }) => id))

export function runtimeToolId(value: unknown): RuntimeToolId {
  if (typeof value !== 'string' || !TOOL_IDS.has(value)) {
    throw new Error('Choose a supported development tool to install.')
  }
  return value as RuntimeToolId
}

/**
 * Resolve an installer from a fixed allowlist. No executable or argument from
 * the renderer is ever passed through to a child process.
 */
export function installationPlanFor(toolId: RuntimeToolId): RuntimeInstallationPlan | undefined {
  if (toolId === 'homebrew') return { kind: 'homebrew-installer' }
  if (XCODE_COMMAND_LINE_TOOLS.has(toolId)) {
    return {
      kind: 'xcode-command-line-tools',
      executable: '/usr/bin/xcode-select',
      args: ['--install']
    }
  }
  const pkg = HOMEBREW_PACKAGES[toolId]
  return pkg
    ? { kind: 'homebrew-package', packageName: pkg.name, cask: pkg.cask === true }
    : undefined
}

interface ActiveInstallation {
  toolId: RuntimeToolId
  controller: AbortController
  child?: ChildProcess
  cancelled: boolean
}

type ProgressListener = (progress: ToolInstallationProgress) => void
type OpenPath = (target: string) => Promise<string>

export interface RuntimeInstallerOptions {
  openPath?: OpenPath
}

function plainOutput(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 320)
}

function phaseMessage(phase: ToolInstallationPhase, toolName: string): string {
  if (phase === 'preparing') return `Preparing ${toolName}…`
  if (phase === 'downloading') return `Downloading ${toolName}…`
  if (phase === 'installing') return `Installing ${toolName}…`
  if (phase === 'starting') return `Starting ${toolName}…`
  if (phase === 'waiting-for-user') return 'Continue in the macOS installer.'
  if (phase === 'completed') return `${toolName} is ready.`
  if (phase === 'cancelled') return `${toolName} installation was cancelled.`
  return `${toolName} installation failed.`
}

function terminateChild(child: ChildProcess): void {
  const send = (signal: NodeJS.Signals): void => {
    if (child.pid && child.pid > 1) {
      try { process.kill(-child.pid, signal); return } catch { /* Fall back to the child. */ }
    }
    child.kill(signal)
  }
  send('SIGTERM')
  const forceStop = setTimeout(() => send('SIGKILL'), 5_000)
  forceStop.unref()
  child.once('close', () => clearTimeout(forceStop))
}

async function executable(pathname: string): Promise<boolean> {
  try {
    await access(pathname, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export class RuntimeInstaller {
  #active: ActiveInstallation | null = null
  readonly #progress = new Map<string, ToolInstallationProgress>()
  #listener: ProgressListener = () => undefined

  constructor(private readonly options: RuntimeInstallerOptions = {}) {}

  setProgressListener(listener: ProgressListener): void {
    this.#listener = listener
  }

  installations(): ToolInstallationProgress[] {
    return [...this.#progress.values()].map((progress) => ({ ...progress }))
  }

  async install(value: unknown): Promise<ToolInstallationResult> {
    const toolId = runtimeToolId(value)
    const definition = RUNTIME_TOOL_DEFINITIONS.find((tool) => tool.id === toolId)
    if (!definition) throw new Error('Choose a supported development tool to install.')
    if (this.#active) {
      throw new Error(
        `${RUNTIME_TOOL_DEFINITIONS.find((tool) => tool.id === this.#active?.toolId)?.name ?? 'Another tool'} is already being installed.`
      )
    }

    const plan = installationPlanFor(toolId)
    if (!plan) {
      throw new Error(
        toolId === 'xcode'
          ? 'Apple distributes full Xcode through the Mac App Store. Install Xcode Command Line Tools here, or install full Xcode from Apple.'
          : `${definition.name} does not have an in-app installer.`
      )
    }

    const operation: ActiveInstallation = {
      toolId,
      controller: new AbortController(),
      cancelled: false
    }
    this.#active = operation
    this.#emit(toolId, 'preparing', definition.name)

    try {
      const alreadyInstalled = await detectRuntimeTool(toolId)
      this.#throwIfCancelled()
      if (alreadyInstalled.installed && toolId !== 'ollama') {
        this.#emit(toolId, 'completed', definition.name)
        return { toolId, installed: true, cancelled: false }
      }

      if (plan.kind === 'xcode-command-line-tools') {
        await this.#run(plan.executable, plan.args, definition.name, 'installing')
        this.#emit(toolId, 'waiting-for-user', definition.name, {
          detail: 'macOS opened its trusted Software Update installer. Finish the download there, then return to OmniCode.',
          done: true,
          cancellable: false
        })
        return {
          toolId,
          installed: false,
          cancelled: false,
          requiresUserAction: true
        }
      }

      if (plan.kind === 'homebrew-installer') {
        return await this.#downloadAndOpenInstaller(toolId, 'homebrew')
      } else if (!alreadyInstalled.installed) {
        const brew = await this.#homebrewExecutable()
        this.#throwIfCancelled()
        if (!brew) {
          return await this.#downloadAndOpenInstaller(
            toolId,
            toolId === 'ollama' ? 'ollama' : 'homebrew'
          )
        }
        if (plan.cask) return await this.#downloadAndOpenCask(toolId, brew, plan.packageName)
        const args = ['install', plan.packageName]
        await this.#run(brew, args, definition.name, 'installing')
      }

      if (toolId === 'ollama') await this.#startOllama(alreadyInstalled.path)

      const detected = await detectRuntimeTool(toolId)
      this.#throwIfCancelled()
      if (!detected.installed) {
        throw new Error(
          `${definition.name} finished installing but was not detected yet. Restart OmniCode or refresh the tool check after your shell environment updates.`
        )
      }
      this.#emit(toolId, 'completed', definition.name)
      return { toolId, installed: true, cancelled: false }
    } catch (cause) {
      if (operation.cancelled) {
        this.#emit(toolId, 'cancelled', definition.name)
        return { toolId, installed: false, cancelled: true }
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      this.#emit(toolId, 'failed', definition.name, { detail: message, error: message })
      throw cause
    } finally {
      if (this.#active === operation) this.#active = null
    }
  }

  cancel(value: unknown): boolean {
    const toolId = runtimeToolId(value)
    const operation = this.#active
    if (!operation || operation.toolId !== toolId || !this.#progress.get(toolId)?.cancellable) return false
    operation.cancelled = true
    operation.controller.abort()
    if (operation.child) terminateChild(operation.child)
    return true
  }

  shutdown(): void {
    if (this.#active) this.cancel(this.#active.toolId)
  }

  #throwIfCancelled(): void {
    if (!this.#active || this.#active.controller.signal.aborted) {
      throw new Error('The installation was cancelled.')
    }
  }

  #emit(
    toolId: RuntimeToolId,
    phase: ToolInstallationPhase,
    toolName: string,
    overrides: Partial<ToolInstallationProgress> = {}
  ): void {
    const terminal = ['completed', 'cancelled', 'failed', 'waiting-for-user'].includes(phase)
    const progress: ToolInstallationProgress = {
      toolId,
      phase,
      message: phaseMessage(phase, toolName),
      done: terminal,
      cancellable: !terminal,
      ...overrides
    }
    this.#progress.set(toolId, progress)
    this.#listener({ ...progress })
  }

  async #homebrewExecutable(): Promise<string | undefined> {
    for (const candidate of HOMEBREW_PATHS) {
      if (await executable(candidate)) return candidate
    }
    return undefined
  }

  async #downloadAndOpenInstaller(
    requestedToolId: RuntimeToolId,
    installer: 'homebrew' | 'ollama'
  ): Promise<ToolInstallationResult> {
    if (!this.#active) throw new Error('The installation is no longer active.')
    const opener = this.options.openPath
    if (!opener) throw new Error('The native macOS installer opener is unavailable.')
    const metadata = installer === 'homebrew'
      ? { name: 'Homebrew', url: HOMEBREW_INSTALLER_URL, fileName: 'Homebrew.pkg' }
      : { name: 'Ollama', url: OLLAMA_INSTALLER_URL, fileName: 'Ollama.dmg' }
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), `omnicode-${installer}-`))
    const installerPath = path.join(temporaryRoot, metadata.fileName)
    let keepInstaller = false

    try {
      this.#emit(requestedToolId, 'downloading', metadata.name, {
        detail: `Downloading the official ${metadata.name} installer over HTTPS.`,
        percent: 0
      })
      this.#throwIfCancelled()
      const signal = AbortSignal.any([this.#active.controller.signal, AbortSignal.timeout(INSTALL_TIMEOUT_MS)])
      const response = await this.#fetchInstaller(metadata.url, signal)
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error(`The official ${metadata.name} installer could not be downloaded (${response.status}).`)
      }

      const declaredSize = Number(response.headers.get('content-length'))
      const total = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : undefined
      const limit = DOWNLOAD_LIMITS[installer]
      if (total && total > limit) {
        await response.body.cancel()
        throw new Error(`${metadata.name} reported an unexpected installer size.`)
      }

      let completed = 0
      let lastProgressAt = 0
      const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      source.on('data', (chunk: Buffer) => {
        completed += chunk.byteLength
        if (completed > limit) {
          source.destroy(new Error(`${metadata.name} exceeded the maximum expected installer size.`))
          return
        }
        const now = Date.now()
        if (now - lastProgressAt < 120 && (!total || completed < total)) return
        lastProgressAt = now
        this.#emit(requestedToolId, 'downloading', metadata.name, {
          detail: total
            ? `${Math.round(completed / 1024 / 1024)} of ${Math.round(total / 1024 / 1024)} MB`
            : `${Math.round(completed / 1024 / 1024)} MB`,
          percent: total ? Math.min(100, Math.round((completed / total) * 1_000) / 10) : undefined
        })
      })
      await pipeline(source, createWriteStream(installerPath, { flags: 'wx', mode: 0o600 }), { signal })
      if (!completed) throw new Error(`${metadata.name} returned an empty installer download.`)
      if (completed > limit) throw new Error(`${metadata.name} exceeded the maximum expected installer size.`)
      if (total && completed !== total) throw new Error(`${metadata.name} download was incomplete. Please try again.`)
      this.#throwIfCancelled()

      this.#emit(requestedToolId, 'waiting-for-user', metadata.name, {
        detail: `Opening ${metadata.fileName} with the trusted macOS installer.`,
        done: false,
        cancellable: false,
        percent: 100
      })
      const openError = await opener(installerPath)
      if (openError) throw new Error(openError)
      keepInstaller = true
      const nextStep = installer === 'homebrew' && requestedToolId !== 'homebrew'
        ? `Finish installing Homebrew, then choose Install again for ${RUNTIME_TOOL_DEFINITIONS.find((tool) => tool.id === requestedToolId)?.name ?? requestedToolId}.`
        : `Finish installing ${metadata.name} in the macOS window, then return to OmniCode.`
      this.#emit(requestedToolId, 'waiting-for-user', metadata.name, {
        message: nextStep,
        detail: `Downloaded to ${installerPath}`,
        done: true,
        cancellable: false,
        percent: 100
      })
      return {
        toolId: requestedToolId,
        installed: false,
        cancelled: false,
        requiresUserAction: true
      }
    } finally {
      if (!keepInstaller) {
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  async #fetchInstaller(initialURL: string, signal: AbortSignal): Promise<Response> {
    let current = new URL(initialURL)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (current.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(current.hostname) || current.username || current.password || current.port) {
        throw new Error('The installer redirected to an unexpected download address.')
      }
      const response = await fetch(current, { redirect: 'manual', signal })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('The installer download returned an invalid redirect.')
      current = new URL(location, current)
    }
    throw new Error('The installer download redirected too many times.')
  }

  async #downloadAndOpenCask(toolId: RuntimeToolId, brew: string, packageName: string): Promise<ToolInstallationResult> {
    const opener = this.options.openPath
    if (!opener) throw new Error('The native macOS installer opener is unavailable.')
    const name = RUNTIME_TOOL_DEFINITIONS.find((tool) => tool.id === toolId)!.name
    // Casks may need administrator approval. Homebrew downloads and verifies
    // the vendor archive; macOS Installer handles authentication interactively.
    await this.#run(brew, ['fetch', '--cask', packageName], name, 'downloading')
    const output = await this.#run(brew, ['--cache', '--cask', packageName], name, 'preparing')
    const installerPath = output.trim()
    if (!path.isAbsolute(installerPath) || !/\.(?:pkg|dmg)$/iu.test(installerPath) || /[\r\n\0]/u.test(installerPath)) {
      throw new Error(`${name} downloaded, but Homebrew did not return a supported macOS installer.`)
    }
    await access(installerPath, fsConstants.R_OK)
    this.#throwIfCancelled()
    this.#emit(toolId, 'waiting-for-user', name, { done: false, cancellable: false })
    const openError = await opener(installerPath)
    if (openError) throw new Error(openError)
    this.#emit(toolId, 'waiting-for-user', name, {
      message: `Finish installing ${name} in the macOS window, then return to OmniCode.`,
      detail: `Downloaded to ${installerPath}`,
      done: true,
      cancellable: false
    })
    return { toolId, installed: false, cancelled: false, requiresUserAction: true }
  }

  async #startOllama(installedPath?: string): Promise<void> {
    if (await this.#ollamaAvailable()) return
    this.#emit('ollama', 'starting', 'Ollama', {
      detail: 'Starting the local Ollama service.'
    })

    const detected = installedPath ? { path: installedPath } : await detectRuntimeTool('ollama')
    if (!detected.path) throw new Error('Ollama was installed, but its executable could not be found to start the local service.')
    const environment = await this.#safeEnvironment()
    this.#throwIfCancelled()
    const child = spawn(detected.path, ['serve'], {
      detached: true,
      env: { ...environment, OLLAMA_HOST: '127.0.0.1:11434' },
      stdio: 'ignore'
    })
    this.#active!.child = child
    let ready = false
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      for (let attempt = 0; attempt < 30; attempt += 1) {
        this.#throwIfCancelled()
        if (await this.#ollamaAvailable()) {
          this.#throwIfCancelled()
          ready = true
          child.unref()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error('Ollama is installed, but its local service did not become ready. Try starting Ollama again.')
    } finally {
      if (!ready) terminateChild(child)
      if (this.#active?.child === child) this.#active.child = undefined
    }
  }

  async #ollamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch(OLLAMA_URL, { signal: AbortSignal.timeout(1_500) })
      if (!response.ok) return false
      const payload = await response.json() as { version?: unknown }
      return typeof payload.version === 'string' && payload.version.trim().length > 0
    } catch {
      return false
    }
  }

  async #safeEnvironment(): Promise<NodeJS.ProcessEnv> {
    const resolved = await resolveShellEnvironment()
    const safe: NodeJS.ProcessEnv = {
      PATH: resolved.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    }
    for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_CTYPE', 'TERM'] as const) {
      const value = process.env[key]
      if (value) safe[key] = value
    }
    return safe
  }

  async #run(
    executablePath: string,
    args: readonly string[],
    toolName: string,
    phase: 'installing' | 'starting' | 'downloading' | 'preparing'
  ): Promise<string> {
    if (!this.#active) throw new Error('The installation is no longer active.')
    const environment = await this.#safeEnvironment()
    this.#throwIfCancelled()
    this.#emit(this.#active.toolId, phase, toolName)
    const child = spawn(executablePath, [...args], {
      detached: true,
      env: {
        ...environment,
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ENV_HINTS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.#active.child = child

    let lastDetailAt = 0
    let output = ''
    let lastDetail = ''
    const consume = (chunk: Buffer | string): void => {
      const lines = String(chunk).split(/\r?\n/u).map(plainOutput).filter(Boolean)
      const detail = lines.at(-1)
      if (detail) lastDetail = detail
      const now = Date.now()
      if (detail && this.#active && now - lastDetailAt >= 120) {
        lastDetailAt = now
        this.#emit(this.#active.toolId, phase, toolName, { detail })
      }
    }
    child.stdout?.on('data', consume)
    child.stdout?.on('data', (chunk: Buffer | string) => { output = (output + String(chunk)).slice(-64 * 1024) })
    child.stderr?.on('data', consume)

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          terminateChild(child)
          reject(new Error(`${toolName} installation timed out after 60 minutes.`))
        }, INSTALL_TIMEOUT_MS)
        timeout.unref()
        const finish = (callback: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          callback()
        }
        child.once('error', (error) => finish(() => reject(error)))
        child.once('close', (code, signal) => finish(() => {
          if (this.#active?.cancelled) {
            reject(new Error(`${toolName} installation was cancelled.`))
          } else if (code === 0) {
            resolve()
          } else {
            reject(new Error(
              `${toolName} installer exited ${signal ? `with ${signal}` : `with code ${code ?? 'unknown'}`}.${lastDetail ? ` ${lastDetail}` : ''}`
            ))
          }
        }))
      })
      this.#throwIfCancelled()
      return output
    } finally {
      if (this.#active?.child === child) this.#active.child = undefined
    }
  }
}
