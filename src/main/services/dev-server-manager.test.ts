import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DevServerManager } from './dev-server-manager'

const temporaryRoots: string[] = []
const servers: DevServerManager[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('static development server', () => {
  it('serves project assets but refuses credentials and metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-server-'))
    temporaryRoots.push(root)
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, 'index.html'), '<main>OmniCode</main>')
    await fs.writeFile(path.join(root, 'public.txt'), 'safe')
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret')
    await fs.writeFile(path.join(root, '.git', 'config'), '[remote]')

    const server = new DevServerManager()
    servers.push(server)
    const state = await server.start(root)
    expect(state.url).toBeTruthy()
    expect(await fetch(`${state.url}/public.txt`).then((response) => response.text())).toBe('safe')
    expect((await fetch(`${state.url}/.env`)).status).toBe(403)
    expect((await fetch(`${state.url}/.git/config`)).status).toBe(403)
  })

  it('serves nested assets, injects live reload, broadcasts changes, and releases its port', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-server-'))
    temporaryRoots.push(root)
    await fs.mkdir(path.join(root, 'assets'))
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><link rel="stylesheet" href="assets/site.css"><script src="assets/site.js"></script><main>OmniCode</main></body>')
    await fs.writeFile(path.join(root, 'assets', 'site.css'), 'main { color: blue; }')
    await fs.writeFile(path.join(root, 'assets', 'site.js'), 'globalThis.omnicodeServerTest = true')

    const server = new DevServerManager()
    servers.push(server)
    const state = await server.start(root)
    const html = await fetch(`${state.url}/`).then((response) => response.text())
    expect(html).toContain("new EventSource('/__omnicode_events')")
    expect(await fetch(`${state.url}/assets/site.css`).then((response) => response.text())).toContain('color: blue')
    expect(await fetch(`${state.url}/assets/site.js`).then((response) => response.text())).toContain('omnicodeServerTest')

    const controller = new AbortController()
    const eventStream = fetch(`${state.url}/__omnicode_events`, { signal: controller.signal })
    const response = await eventStream
    const reader = response.body?.getReader()
    expect(reader).toBeTruthy()
    await reader?.read()
    const changed = reader?.read()
    await fs.writeFile(path.join(root, 'assets', 'site.css'), 'main { color: green; }')
    const reload = await Promise.race([
      changed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Live reload event timed out.')), 5_000))
    ])
    expect(new TextDecoder().decode(reload?.value)).toContain('event: reload')
    controller.abort()

    const usedPort = state.port
    await server.stop()
    expect(server.state()).toEqual({ running: false })
    const rebound = http.createServer()
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject)
      rebound.listen(usedPort, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve()))
  })

  it('reports an explicit port conflict and remains stopped', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-server-'))
    temporaryRoots.push(root)
    await fs.writeFile(path.join(root, 'index.html'), '<main>OmniCode</main>')
    const occupied = http.createServer((_request, response) => response.end('occupied'))
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('Could not determine occupied test port.')

    const server = new DevServerManager()
    servers.push(server)
    try {
      await expect(server.start(root, address.port)).rejects.toThrow(/port|address|use/iu)
      expect(server.state().running).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe('package development server', () => {
  async function npmWorkspace(script: string, source?: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-npm-server-'))
    temporaryRoots.push(root)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: script } }))
    if (source) await fs.writeFile(path.join(root, 'server.mjs'), source)
    return root
  }

  it('does not report success when a package script exits before serving', async () => {
    const root = await npmWorkspace('node -e "process.exit(7)"')
    const server = new DevServerManager()
    servers.push(server)

    await expect(server.startProject(root, 'dev')).rejects.toThrow(/exited.*7|start/iu)
    expect(server.state()).toMatchObject({ running: false, mode: 'project' })
  })

  it('waits for a reachable server, detects its URL, and stops the process tree', async () => {
    const root = await npmWorkspace('node server.mjs', `
      import http from 'node:http'
      const port = Number(process.env.PORT || 0)
      const server = http.createServer((_request, response) => response.end('NPM_SERVER_OK'))
      server.listen(port, '127.0.0.1', () => console.log('Listening at http://localhost:' + server.address().port))
      process.on('SIGTERM', () => server.close(() => process.exit(0)))
    `)
    const server = new DevServerManager()
    servers.push(server)

    const state = await server.startProject(root, 'dev')
    expect(state).toMatchObject({ running: true, mode: 'project', script: 'dev' })
    if (!state.url) throw new Error('The package server did not report a URL.')
    expect(await fetch(state.url).then((response) => response.text())).toBe('NPM_SERVER_OK')
    const usedPort = state.port
    await server.stop()
    expect(server.state()).toEqual({ running: false })

    const rebound = http.createServer()
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject)
      rebound.listen(usedPort, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve()))
  }, 20_000)
})
