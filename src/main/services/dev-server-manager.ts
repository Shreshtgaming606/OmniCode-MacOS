import { createReadStream, promises as fs } from 'node:fs'
import http, { type Server, type ServerResponse } from 'node:http'
import { createConnection, createServer as createNetServer } from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import chokidar, { type FSWatcher } from 'chokidar'
import { shell } from 'electron'
import type { DevServerOption, ServerState } from '../../shared/contracts'
import { isPathInside } from './filesystem-manager'
import { isSensitiveWorkspacePath } from './sensitive-paths'
import { resolveShellEnvironment } from './shell-environment'

const LIVE_RELOAD_CLIENT = `<script>(()=>{const e=new EventSource('/__omnicode_events');e.addEventListener('reload',()=>location.reload());})();</script>`
const PROJECT_START_TIMEOUT_MS = 30_000

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
}

interface LocalServerCandidate {
  host: string
  port: number
  url: string
}

function cleanTerminalOutput(value: string): string {
  return value.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
}

function localServerCandidates(value: string): LocalServerCandidate[] {
  const output = cleanTerminalOutput(value)
  const candidates = new Map<number, LocalServerCandidate>()
  for (const match of output.matchAll(/(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})/giu)) {
    const port = Number(match[3])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue
    const host = match[2].startsWith('[::') ? '::1' : '127.0.0.1'
    candidates.set(port, { host, port, url: `${match[1].toLowerCase()}://localhost:${port}` })
  }
  for (const match of output.matchAll(/(?:listen(?:ing)?|server|started|ready)[^\r\n]{0,60}?(?:port\s*)?(\d{2,5})/giu)) {
    const port = Number(match[1])
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || candidates.has(port)) continue
    candidates.set(port, { host: '127.0.0.1', port, url: `http://localhost:${port}` })
  }
  return [...candidates.values()]
}

async function canConnect(candidate: LocalServerCandidate): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: candidate.host, port: candidate.port })
    let settled = false
    const finish = (connected: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(350)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function isPortAvailable(port: number): Promise<boolean> {
  const probe = createNetServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

export class DevServerManager {
  private server: Server | null = null
  private watcher: FSWatcher | null = null
  private projectProcess: ChildProcess | null = null
  private clients = new Set<ServerResponse>()
  private currentState: ServerState = { running: false }
  private onStateChanged: (state: ServerState) => void = () => undefined
  private onLogLine: (line: string) => void = () => undefined

  setStateListener(listener: (state: ServerState) => void): void {
    this.onStateChanged = listener
  }

  setLogListener(listener: (line: string) => void): void {
    this.onLogLine = listener
  }

  async detect(root: string): Promise<DevServerOption[]> {
    const options: DevServerOption[] = [{ id: 'static', name: 'Static server with live reload', framework: 'HTML / CSS / JavaScript', kind: 'static' }]
    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
      const packageManager: DevServerOption['packageManager'] = await fs.access(path.join(root, 'pnpm-lock.yaml')).then(() => 'pnpm' as const).catch(async () =>
        fs.access(path.join(root, 'yarn.lock')).then(() => 'yarn' as const).catch(async () =>
          Promise.any([fs.access(path.join(root, 'bun.lockb')), fs.access(path.join(root, 'bun.lock'))]).then(() => 'bun' as const).catch(() => 'npm' as const)))
      const framework = dependencies.next ? 'Next.js' : dependencies.vite ? 'Vite' : dependencies.astro ? 'Astro'
        : dependencies['@sveltejs/kit'] || dependencies.svelte ? 'Svelte' : dependencies.vue ? 'Vue'
          : dependencies.react ? 'React' : dependencies.express ? 'Express' : 'Node.js'
      const preferred = ['dev', 'start', 'serve', 'preview']
      for (const name of Object.keys(packageJson.scripts ?? {}).sort((a, b) => preferred.indexOf(a) - preferred.indexOf(b))) {
        const command = packageJson.scripts?.[name] ?? ''
        if (!preferred.includes(name) && !/(vite|next|astro|svelte|vue-cli-service|serve|webpack|express)/i.test(command)) continue
        options.push({ id: `${packageManager}:${name}`, name: `${packageManager} run ${name}`, framework, script: name, packageManager, kind: 'package' })
      }
    } catch { /* a package manifest is optional */ }
    return options
  }

  state(): ServerState {
    return { ...this.currentState }
  }

  async start(root: string, requestedPort = 0): Promise<ServerState> {
    await this.stop()
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) throw new Error('Choose a port between 1 and 65535, or leave it on Auto.')
    const absoluteRoot = await fs.realpath(path.resolve(root))
    const stats = await fs.stat(absoluteRoot)
    if (!stats.isDirectory()) throw new Error('Choose a folder to serve.')

    this.server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/__omnicode_events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'
          })
          response.write(': connected\n\n')
          this.clients.add(response)
          request.on('close', () => this.clients.delete(response))
          return
        }

        const decodedPath = decodeURIComponent(url.pathname)
        let target = path.resolve(absoluteRoot, `.${decodedPath}`)
        if (!isPathInside(absoluteRoot, target)) {
          response.writeHead(403).end('Forbidden')
          return
        }
        if (isSensitiveWorkspacePath(absoluteRoot, target)) {
          response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden')
          return
        }
        let targetStats = await fs.stat(target).catch(() => null)
        if (targetStats?.isDirectory()) {
          target = path.join(target, 'index.html')
          targetStats = await fs.stat(target).catch(() => null)
        }
        if (!targetStats?.isFile()) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
          return
        }
        target = await fs.realpath(target)
        if (!isPathInside(absoluteRoot, target) || isSensitiveWorkspacePath(absoluteRoot, target)) {
          response.writeHead(403).end('Forbidden')
          return
        }
        const extension = path.extname(target).toLowerCase()
        if (extension === '.html') {
          const html = await fs.readFile(target, 'utf8')
          const injected = html.includes('</body>') ? html.replace('</body>', `${LIVE_RELOAD_CLIENT}</body>`) : html + LIVE_RELOAD_CLIENT
          response.writeHead(200, { 'Content-Type': MIME_TYPES[extension], 'Cache-Control': 'no-cache' }).end(injected)
        } else {
          response.writeHead(200, { 'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream' })
          createReadStream(target).pipe(response)
        }
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error instanceof Error ? error.message : 'Server error')
      }
    })

    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once('error', reject)
        this.server?.listen(requestedPort, '127.0.0.1', () => resolve())
      })
    } catch (cause) {
      this.server = null
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      if (code === 'EADDRINUSE') throw new Error(`Port ${requestedPort} is already in use. Choose Auto or another port.`)
      throw cause
    }
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Could not determine the local server port.')
    this.currentState = { running: true, port: address.port, url: `http://localhost:${address.port}`, root: absoluteRoot, mode: 'static', name: 'Static server' }
    this.watcher = chokidar.watch(absoluteRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: /(^|[/\\])(\.git|node_modules|dist|build)([/\\]|$)/
    })
    this.watcher.on('change', () => this.broadcastReload())
    this.watcher.on('add', () => this.broadcastReload())
    this.watcher.on('unlink', () => this.broadcastReload())
    this.onStateChanged(this.state())
    return this.state()
  }

  async startProject(root: string, script: string, requestedPort?: number): Promise<ServerState> {
    await this.stop()
    if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535)) throw new Error('Choose a port between 1 and 65535.')
    if (requestedPort && !(await isPortAvailable(requestedPort))) {
      throw new Error(`Port ${requestedPort} is already in use. Choose Auto or another port.`)
    }
    const absoluteRoot = await fs.realpath(path.resolve(root))
    if (!(await fs.stat(absoluteRoot)).isDirectory()) throw new Error('Choose a project folder to serve.')
    const options = await this.detect(absoluteRoot)
    const selected = options.find((option) => option.kind === 'package' && option.script === script)
    if (!selected) throw new Error('That development-server script is not defined by this workspace.')
    const args = ['run', script]
    if (requestedPort && Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65_536) {
      args.push('--', selected.framework === 'Next.js' ? '-p' : '--port', String(requestedPort))
    }
    const shellEnvironment = await resolveShellEnvironment()
    const child = spawn(selected.packageManager ?? 'npm', args, {
      cwd: absoluteRoot,
      env: { ...shellEnvironment, ...(requestedPort ? { PORT: String(requestedPort) } : {}), FORCE_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    this.projectProcess = child
    let outputBuffer = ''
    let startupFailure: Error | undefined
    const candidates = new Map<number, LocalServerCandidate>()
    if (requestedPort) candidates.set(requestedPort, { host: '127.0.0.1', port: requestedPort, url: `http://localhost:${requestedPort}` })
    const baseState: ServerState = {
      running: false,
      root: absoluteRoot,
      mode: 'project',
      name: selected.name,
      script
    }
    this.currentState = baseState
    this.onStateChanged(this.state())
    const consume = (chunk: string): void => {
      outputBuffer += chunk
      for (const candidate of localServerCandidates(chunk)) candidates.set(candidate.port, candidate)
      const lines = outputBuffer.split(/\r?\n/)
      outputBuffer = lines.pop() ?? ''
      for (const line of lines) {
        this.onLogLine(line)
        for (const candidate of localServerCandidates(line)) candidates.set(candidate.port, candidate)
      }
    }
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', consume); child.stderr?.on('data', consume)
    child.on('error', (error) => {
      startupFailure = error
      if (this.projectProcess === child) {
        this.currentState = { ...baseState, error: error.message }
        this.projectProcess = null
        this.onStateChanged(this.state())
      }
    })
    child.on('exit', (code, signal) => {
      if (outputBuffer.trim()) this.onLogLine(outputBuffer)
      const exitDescription = signal ? `with ${signal}` : `with code ${code ?? 0}`
      startupFailure = new Error(`Development server exited ${exitDescription} before it became reachable.`)
      if (this.projectProcess === child) {
        this.projectProcess = null
        this.currentState = { ...baseState, error: code && code !== 0 ? `Development server exited with code ${code}.` : 'Development server stopped.' }
        this.onLogLine(`[process exited ${exitDescription}]`)
        this.onStateChanged(this.state())
      }
    })

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const deadline = Date.now() + PROJECT_START_TIMEOUT_MS
      let ready: LocalServerCandidate | undefined
      while (!ready && Date.now() < deadline) {
        if (startupFailure) throw startupFailure
        for (const candidate of candidates.values()) {
          if (await canConnect(candidate)) {
            ready = candidate
            break
          }
        }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!ready) throw new Error('Development server did not open a localhost port within 30 seconds. Check the server output and project dependencies.')
      if (startupFailure) throw startupFailure
      this.currentState = { ...baseState, running: true, port: ready.port, url: ready.url }
      this.onStateChanged(this.state())
      return this.state()
    } catch (cause) {
      if (this.projectProcess === child) {
        this.projectProcess = null
        await this.terminateProjectProcess(child)
      }
      const message = cause instanceof Error ? cause.message : 'Development server could not start.'
      this.currentState = { ...baseState, error: message }
      this.onStateChanged(this.state())
      throw new Error(message)
    }
  }

  async stop(): Promise<ServerState> {
    for (const client of this.clients) client.end()
    this.clients.clear()
    if (this.watcher) await this.watcher.close()
    this.watcher = null
    if (this.server) await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    this.server = null
    const projectProcess = this.projectProcess
    this.projectProcess = null
    if (projectProcess) await this.terminateProjectProcess(projectProcess)
    this.currentState = { running: false }
    this.onStateChanged(this.state())
    return this.state()
  }

  async open(): Promise<void> {
    if (!this.currentState.url) throw new Error('Start the local server first.')
    await shell.openExternal(this.currentState.url)
  }

  private broadcastReload(): void {
    for (const client of this.clients) client.write('event: reload\ndata: now\n\n')
  }

  private async terminateProjectProcess(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    const pid = child.pid
    try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 750))
    ])
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
}
