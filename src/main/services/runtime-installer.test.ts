import { EventEmitter } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeInstaller, installationPlanFor } from './runtime-installer'
import { detectRuntimeTool, type RuntimeToolInfo } from './runtime-manager'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('./shell-environment', () => ({ resolveShellEnvironment: async () => ({ PATH: '/usr/bin:/bin' }) }))
vi.mock('./runtime-manager', async (original) => ({
  ...await original<typeof import('./runtime-manager')>(),
  detectRuntimeTool: vi.fn()
}))
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(),
  access: vi.fn()
}))

const payload = 'mock installer bytes, never executable'
const downloadedDirectories: string[] = []
const detector = vi.mocked(detectRuntimeTool)
const spawnMock = vi.mocked(spawn)
const accessMock = vi.mocked(access)

function detection(installed: boolean, location?: string): RuntimeToolInfo {
  return { id: 'node', name: 'Node.js', command: 'node', installed, path: location, detectedPaths: [] }
}

function processResult(output = '', code = 0, pending = false): ReturnType<typeof spawn> {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    unref: vi.fn(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true })
  })
  queueMicrotask(() => {
    child.emit('spawn')
    if (!pending) {
      child.stdout.emit('data', output)
      child.emit('close', code, null)
    }
  })
  return child as unknown as ReturnType<typeof spawn>
}

function mockDownload() {
  const fetchMock = vi.fn(async () => new Response(payload, {
    headers: { 'content-length': String(Buffer.byteLength(payload)) }
  }))
  vi.stubGlobal('fetch', fetchMock)
  const openPath = vi.fn(async (target: string) => {
    downloadedDirectories.push(path.dirname(target))
    expect(await readFile(target, 'utf8')).toBe(payload)
    return ''
  })
  return { fetchMock, openPath }
}

beforeEach(() => {
  vi.clearAllMocks()
  detector.mockResolvedValue(detection(false))
  accessMock.mockRejectedValue(new Error('ENOENT'))
  spawnMock.mockImplementation(() => processResult())
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(downloadedDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('RuntimeInstaller', () => {
  it('downloads Homebrew itself when a requested runtime needs it, and reports the native installer handoff', async () => {
    const { fetchMock, openPath } = mockDownload()
    const installer = new RuntimeInstaller({ openPath })
    const result = await installer.install('node')
    expect(result).toEqual({ toolId: 'node', installed: false, cancelled: false, requiresUserAction: true })
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'github.com' }), expect.objectContaining({ redirect: 'manual' }))
    expect(openPath).toHaveBeenCalledWith(expect.stringMatching(/Homebrew\.pkg$/u))
    expect(installer.installations()[0]).toMatchObject({ phase: 'waiting-for-user', done: true, cancellable: false })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('downloads Ollama directly when Homebrew is unavailable', async () => {
    const { fetchMock, openPath } = mockDownload()
    const installer = new RuntimeInstaller({ openPath })
    expect(await installer.install('ollama')).toMatchObject({ requiresUserAction: true, installed: false })
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'ollama.com' }), expect.anything())
    expect(openPath).toHaveBeenCalledWith(expect.stringMatching(/Ollama\.dmg$/u))
  })

  it('refuses an unexpected redirect before requesting that destination', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
    vi.stubGlobal('fetch', fetchMock)
    const openPath = vi.fn()
    const installer = new RuntimeInstaller({ openPath })
    await expect(installer.install('homebrew')).rejects.toThrow('unexpected download address')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(openPath).not.toHaveBeenCalled()
    expect(installer.installations()[0].phase).toBe('failed')
  })

  it('rejects a truncated download without opening it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('short', { headers: { 'content-length': '100' } })))
    const openPath = vi.fn()
    await expect(new RuntimeInstaller({ openPath }).install('homebrew')).rejects.toThrow('incomplete')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('cancels an in-progress download without launching the native installer', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')) } })
    const fetchMock = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetchMock)
    const openPath = vi.fn()
    const installer = new RuntimeInstaller({ openPath })
    const result = installer.install('homebrew')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(installer.cancel('homebrew')).toBe(true)
    expect(await result).toMatchObject({ cancelled: true, installed: false })
    expect(openPath).not.toHaveBeenCalled()
    expect(installer.installations()[0].phase).toBe('cancelled')
  })

  it('installs formulae using fixed arguments, then verifies the tool is usable', async () => {
    accessMock.mockResolvedValue(undefined)
    detector.mockResolvedValueOnce(detection(false)).mockResolvedValueOnce(detection(true, '/opt/homebrew/bin/node'))
    const installer = new RuntimeInstaller()
    expect(await installer.install('node')).toEqual({ toolId: 'node', installed: true, cancelled: false })
    expect(spawnMock).toHaveBeenCalledWith('/opt/homebrew/bin/brew', ['install', 'node'], expect.objectContaining({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: expect.objectContaining({ HOMEBREW_NO_AUTO_UPDATE: '1' })
    }))
    expect(installer.installations()[0].phase).toBe('completed')
  })

  it('downloads a cask and opens its verified native installer instead of requiring sudo over a closed stdin', async () => {
    accessMock.mockResolvedValue(undefined)
    spawnMock.mockImplementation((_executable, args) => processResult(args?.[0] === '--cache' ? '/mock/cache/temurin.pkg\n' : 'Download complete'))
    const openPath = vi.fn(async () => '')
    const installer = new RuntimeInstaller({ openPath })
    expect(await installer.install('java')).toMatchObject({ requiresUserAction: true, installed: false })
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([['fetch', '--cask', 'temurin'], ['--cache', '--cask', 'temurin']])
    expect(openPath).toHaveBeenCalledWith('/mock/cache/temurin.pkg')
  })

  it('rejects renderer-supplied commands and aliases without an installer plan', async () => {
    const installer = new RuntimeInstaller()
    await expect(installer.install('node; touch /tmp/untrusted')).rejects.toThrow('supported development tool')
    expect(installationPlanFor('python')).toBeUndefined()
    await expect(installer.install('python')).rejects.toThrow('does not have an in-app installer')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not start any process when cancelled during initial detection', async () => {
    let completeDetection!: (value: RuntimeToolInfo) => void
    detector.mockImplementationOnce(() => new Promise((resolve) => { completeDetection = resolve }))
    const installer = new RuntimeInstaller()
    const result = installer.install('node')
    expect(installer.cancel('node')).toBe(true)
    completeDetection(detection(false))
    expect(await result).toMatchObject({ cancelled: true })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('allows only one active installation and cancels a running package command', async () => {
    accessMock.mockResolvedValue(undefined)
    spawnMock.mockImplementation(() => processResult('', 0, true))
    const installer = new RuntimeInstaller()
    const result = installer.install('node')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    await expect(installer.install('go')).rejects.toThrow('already being installed')
    expect(installer.cancel('node')).toBe(true)
    expect(await result).toMatchObject({ cancelled: true })
    expect(spawnMock.mock.results[0].value.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('includes a useful package-manager failure message', async () => {
    accessMock.mockResolvedValue(undefined)
    spawnMock.mockImplementation(() => processResult('Error: insufficient disk space', 1))
    const installer = new RuntimeInstaller()
    await expect(installer.install('go')).rejects.toThrow('insufficient disk space')
    expect(installer.installations()[0]).toMatchObject({ phase: 'failed', done: true })
  })

  it('starts the installed Ollama app binary and waits for its local API', async () => {
    const cli = '/Applications/Ollama.app/Contents/Resources/ollama'
    detector.mockResolvedValue(detection(true, cli))
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('not started')).mockResolvedValue(new Response(JSON.stringify({ version: '0.17.0' })))
    vi.stubGlobal('fetch', fetchMock)
    const installer = new RuntimeInstaller()
    expect(await installer.install('ollama')).toMatchObject({ installed: true, cancelled: false })
    expect(spawnMock).toHaveBeenCalledWith(cli, ['serve'], expect.objectContaining({ env: expect.objectContaining({ OLLAMA_HOST: '127.0.0.1:11434' }) }))
    expect(spawnMock.mock.results[0].value.unref).toHaveBeenCalled()
  })
})
