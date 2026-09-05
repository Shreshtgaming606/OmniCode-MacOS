import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENVIRONMENT_MARKER = '\0__OMNICODE_ENVIRONMENT__\0'
const MAX_ENVIRONMENT_BYTES = 1024 * 1024

let cachedEnvironment: Promise<NodeJS.ProcessEnv> | null = null

function uniquePaths(values: Array<string | undefined>): string[] {
  return [...new Set(values.flatMap((value) => value?.split(path.delimiter) ?? []).filter(Boolean))]
}

function withCommonMacPaths(environment: NodeJS.ProcessEnv, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = environment.HOME || base.HOME || os.homedir()
  const pathEntries = uniquePaths([
    environment.PATH,
    base.PATH,
    '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin')
  ])
  return { ...base, ...environment, PATH: pathEntries.join(path.delimiter) }
}

function parseEnvironment(output: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const markerIndex = output.indexOf(ENVIRONMENT_MARKER)
  if (markerIndex < 0) return withCommonMacPaths({}, base)
  const parsed: NodeJS.ProcessEnv = {}
  for (const record of output.slice(markerIndex + ENVIRONMENT_MARKER.length).split('\0')) {
    const separator = record.indexOf('=')
    if (separator <= 0) continue
    const name = record.slice(0, separator)
    const value = record.slice(separator + 1)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !value.includes('\0')) parsed[name] = value
  }
  return withCommonMacPaths(parsed, base)
}

async function loadShellEnvironment(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'darwin') return withCommonMacPaths({}, base)
  const configuredShell = base.SHELL
  const shell = configuredShell && path.isAbsolute(configuredShell) && existsSync(configuredShell)
    ? configuredShell
    : '/bin/zsh'
  return new Promise((resolve) => {
    const child = spawn(shell, ['-ilc', "printf '\\0__OMNICODE_ENVIRONMENT__\\0'; /usr/bin/env -0"], {
      env: { ...base, TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let output = ''
    let settled = false
    const finish = (environment?: NodeJS.ProcessEnv): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(environment ?? withCommonMacPaths({}, base))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish()
    }, 5_000)
    timer.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (output.length >= MAX_ENVIRONMENT_BYTES) return
      output += chunk.slice(0, MAX_ENVIRONMENT_BYTES - output.length)
    })
    child.on('error', () => finish())
    child.on('close', () => finish(parseEnvironment(output, base)))
  })
}

/**
 * Finder-launched GUI apps receive a minimal PATH. Resolve a login-shell
 * environment once so terminals, runtimes, Git, and package scripts see the
 * same Homebrew/version-manager tools as the user's normal Terminal.
 */
export function resolveShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  cachedEnvironment ??= loadShellEnvironment(process.env)
  return cachedEnvironment
}

export function resetShellEnvironmentCacheForTests(): void {
  cachedEnvironment = null
}

export { parseEnvironment, withCommonMacPaths }
