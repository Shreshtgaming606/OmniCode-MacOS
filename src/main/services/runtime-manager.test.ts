import { describe, expect, it, vi } from 'vitest'

import {
  HOMEBREW_PATHS,
  RuntimeManager,
  runExecutable,
  type CommandExecutionResult,
  type SafeCommandRunner
} from './runtime-manager'

const success = (stdout: string): CommandExecutionResult => ({
  ok: true,
  stdout,
  stderr: '',
  exitCode: 0
})

const missing = (): CommandExecutionResult => ({
  ok: false,
  stdout: '',
  stderr: 'command not found',
  exitCode: null,
  errorCode: 'ENOENT'
})

describe('runExecutable', () => {
  it('passes metacharacters as literal arguments without shell interpolation', async () => {
    const payload = 'literal; $(printf unsafe) && `printf unsafe`'
    const result = await runExecutable(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      payload
    ])

    expect(result.ok).toBe(true)
    expect(result.stdout).toBe(payload)
  })
})

describe('RuntimeManager', () => {
  it('detects both Apple Silicon and Intel Homebrew locations', async () => {
    const runner = vi.fn<SafeCommandRunner>(async (executable) => {
      if (HOMEBREW_PATHS.includes(executable as (typeof HOMEBREW_PATHS)[number])) {
        return success('Homebrew 4.6.0\n')
      }
      return missing()
    })
    const manager = new RuntimeManager({
      runner,
      isExecutable: async (path) => HOMEBREW_PATHS.includes(
        path as (typeof HOMEBREW_PATHS)[number]
      ),
      platform: 'darwin'
    })

    const homebrew = await manager.detect('homebrew')

    expect(homebrew.installed).toBe(true)
    expect(homebrew.path).toBe('/opt/homebrew/bin/brew')
    expect(homebrew.detectedPaths).toEqual([...HOMEBREW_PATHS])
    expect(homebrew.version).toBe('Homebrew 4.6.0')
  })

  it('returns actionable guidance when a runtime is missing', async () => {
    const runner = vi.fn<SafeCommandRunner>(async () => missing())
    const manager = new RuntimeManager({
      runner,
      isExecutable: async () => false,
      platform: 'darwin'
    })

    const node = await manager.detect('node')

    expect(node.installed).toBe(false)
    expect(node.path).toBeUndefined()
    expect(node.guidance).toContain('brew install node')
    expect(node.guidance).toContain('https://nodejs.org/en/download')
    expect(node.installation).toMatchObject({
      command: 'brew install node'
    })
  })

  it('does not mistake the xcode-select shim for installed command line tools', async () => {
    const runner = vi.fn<SafeCommandRunner>(async (executable, args = []) => {
      if (executable === '/usr/bin/which') return success('/usr/bin/xcode-select\n')
      if (executable === '/usr/bin/xcode-select' && args[0] === '-p') {
        return {
          ok: false,
          stdout: '',
          stderr: 'Unable to get active developer directory.',
          exitCode: 2
        }
      }
      return missing()
    })
    const manager = new RuntimeManager({
      runner,
      isExecutable: async (path) => path === '/usr/bin/xcode-select',
      platform: 'darwin'
    })

    const tools = await manager.detect('xcode-command-line-tools')

    expect(tools.installed).toBe(false)
    expect(tools.diagnostic).toContain('Unable to get active developer directory')
    expect(tools.guidance).toContain('xcode-select --install')
  })

  it('continues past a broken Apple shim to a working Homebrew Python', async () => {
    const runner = vi.fn<SafeCommandRunner>(async (executable) =>
      executable === '/opt/homebrew/bin/python3' ? success('Python 3.14.0') : missing()
    )
    const manager = new RuntimeManager({
      runner,
      isExecutable: async (location) => ['/usr/bin/python3', '/opt/homebrew/bin/python3'].includes(location),
      platform: 'darwin'
    })
    expect(await manager.detect('python3')).toMatchObject({
      installed: true,
      path: '/opt/homebrew/bin/python3'
    })
    expect(runner).not.toHaveBeenCalledWith('/usr/bin/python3', expect.anything(), expect.anything())
    expect(runner).not.toHaveBeenCalledWith('python3', expect.anything(), expect.anything())
  })

  it.each([
    ['xcode', 'xcodebuild'], ['git', 'git'], ['python3', 'python3'],
    ['clang', 'clang'], ['clang++', 'clang++'], ['swift', 'swift'],
    ['swiftc', 'swiftc'], ['make', 'make']
  ] as const)('does not execute the %s Apple shim when developer tools are absent', async (toolId, command) => {
    const shim = `/usr/bin/${command}`
    const runner = vi.fn<SafeCommandRunner>(async (executable) => {
      if (executable === '/usr/bin/which') return success(`${shim}\n`)
      // A successful shim probe would be a false positive as well as a native
      // installation prompt, so the absence check must prevent this call.
      if (executable === shim || executable === command) return success('unexpected shim invocation')
      return missing()
    })
    const manager = new RuntimeManager({
      runner,
      isExecutable: async (location) => location === shim,
      platform: 'darwin'
    })

    expect(await manager.detect(toolId)).toMatchObject({ installed: false })
    expect(runner).toHaveBeenCalledWith('/usr/bin/xcode-select', ['-p'], expect.anything())
    expect(runner).not.toHaveBeenCalledWith(shim, expect.anything(), expect.anything())
    expect(runner).not.toHaveBeenCalledWith(command, expect.anything(), expect.anything())
  })

  it('keeps custom PATH alternatives detectable without Apple developer tools', async () => {
    const customGit = '/custom/tools/bin/git'
    const runner = vi.fn<SafeCommandRunner>(async (executable) => {
      if (executable === '/usr/bin/which') return success(`/usr/bin/git\n${customGit}\n`)
      if (executable === customGit) return success('git version 2.50.0')
      return missing()
    })
    const manager = new RuntimeManager({
      runner,
      isExecutable: async (location) => location === '/usr/bin/git',
      platform: 'darwin'
    })

    expect(await manager.detect('git')).toMatchObject({ installed: true, path: customGit })
    expect(runner).not.toHaveBeenCalledWith('/usr/bin/git', expect.anything(), expect.anything())
  })

  it('probes Apple tools normally when the selected developer directory exists', async () => {
    const developerDirectory = '/Library/Developer/CommandLineTools'
    const runner = vi.fn<SafeCommandRunner>(async (executable, args = []) => {
      if (executable === '/usr/bin/xcode-select' && args[0] === '-p') return success(`${developerDirectory}\n`)
      if (executable === '/usr/bin/git') return success('git version 2.39.5 (Apple Git-154)')
      return missing()
    })
    const manager = new RuntimeManager({
      runner,
      isExecutable: async (location) => [developerDirectory, '/usr/bin/git', '/usr/bin/xcode-select'].includes(location),
      platform: 'darwin'
    })

    expect(await manager.detect('git')).toMatchObject({ installed: true, path: '/usr/bin/git' })
    expect(await manager.detect('xcode-command-line-tools')).toMatchObject({
      installed: true,
      details: developerDirectory
    })
  })

  it('does not launch an Apple shim when xcode-select reports a stale developer directory', async () => {
    const runner = vi.fn<SafeCommandRunner>(async (executable) => {
      if (executable === '/usr/bin/xcode-select') return success('/Applications/RemovedXcode.app/Contents/Developer\n')
      if (executable === '/usr/bin/which') return success('/usr/bin/git\n')
      return missing()
    })
    const manager = new RuntimeManager({
      runner,
      isExecutable: async (location) => location === '/usr/bin/git',
      platform: 'darwin'
    })

    expect(await manager.detect('git')).toMatchObject({ installed: false })
    expect(runner).not.toHaveBeenCalledWith('/usr/bin/git', expect.anything(), expect.anything())
    expect(runner).not.toHaveBeenCalledWith('git', expect.anything(), expect.anything())
  })

  it('detects the Ollama app before its optional CLI symlink is installed', async () => {
    const cli = '/Applications/Ollama.app/Contents/Resources/ollama'
    const manager = new RuntimeManager({
      runner: async (executable) => executable === cli ? success('ollama version 0.17.0') : missing(),
      isExecutable: async (location) => location === cli,
      platform: 'darwin'
    })
    expect(await manager.detect('ollama')).toMatchObject({ installed: true, path: cli })
  })

  it('does not offer a separate installer for the optional python alias', async () => {
    const manager = new RuntimeManager({ runner: async () => missing(), isExecutable: async () => false })
    expect(await manager.detect('python')).toMatchObject({ installed: false, installable: false })
    expect(await manager.detect('python3')).toMatchObject({ installed: false, installable: true })
  })
})
