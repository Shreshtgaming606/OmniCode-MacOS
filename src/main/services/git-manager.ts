import { spawn } from 'node:child_process'
import path from 'node:path'

import type { GitCloneProgress, GitFileChange, GitRepositoryInfo, GitStatus } from '../../shared/contracts'
import { resolveShellEnvironment } from './shell-environment'

const MAX_GIT_OUTPUT = 16 * 1024 * 1024

interface GitRunOptions {
  allowedExitCodes?: number[]
  signal?: AbortSignal
  onStderr?(chunk: string): void
}

interface GitCloneOptions {
  signal?: AbortSignal
  onProgress?(progress: Pick<GitCloneProgress, 'phase' | 'message' | 'percent'>): void
}

function validatePaths(paths: string[]): void {
  for (const candidate of paths) {
    if (!candidate || candidate.startsWith('-') || path.isAbsolute(candidate) || /[\r\n\0]/.test(candidate)) {
      throw new Error('Git file paths must be relative paths inside the workspace.')
    }
    if (candidate !== '.' && candidate.split(/[\\/]/).includes('..')) {
      throw new Error('Git file paths cannot leave the workspace.')
    }
  }
}

export function redactGitOutput(value: string): string {
  return value
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/giu, '$1••••$2')
    .replaceAll(/(https?:\/\/)[^\s/:@]+(@)/giu, '$1••••$2')
    .replaceAll(/([?&](?:access[_-]?token|auth|key|password|signature|token)=)[^\s&#]+/giu, '$1••••')
    .replaceAll(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{20,})\b/gu, '••••')
}

function parseBranchHeader(header: string): { branch: string; ahead: number; behind: number } {
  const details = header.replace(/^## /, '')
  const ahead = Number(details.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(details.match(/behind (\d+)/)?.[1] ?? 0)
  if (details.startsWith('No commits yet on ')) return { branch: details.slice('No commits yet on '.length), ahead, behind }
  if (details.startsWith('Initial commit on ')) return { branch: details.slice('Initial commit on '.length), ahead, behind }
  if (details.startsWith('HEAD (no branch)')) return { branch: 'HEAD', ahead, behind }
  return { branch: details.split('...')[0]?.trim() || 'HEAD', ahead, behind }
}

export function validateRepositoryUrl(repositoryUrl: string): string {
  const value = repositoryUrl.trim()
  if (!value || value.startsWith('-') || /[\r\n\0]/u.test(value)) throw new Error('Enter a valid Git repository URL.')
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) && !/^[^/@\s]+@[^/:\s]+:.+/u.test(value)) {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('Enter a valid Git repository URL.') }
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') throw new Error('Clone remote repositories with HTTPS or SSH.')
    if (!url.hostname || url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash) {
      throw new Error('Repository URLs cannot contain embedded credentials, query tokens, or fragments.')
    }
  } else if (value.includes('@') || value.includes(':')) {
    if (!/^[^/@\s]+@[^/:\s]+:[^\s]+$/u.test(value)) throw new Error('Enter a valid HTTPS or SSH Git repository URL.')
  }
  return value
}

export function parseGitCloneProgress(value: string): Pick<GitCloneProgress, 'phase' | 'message' | 'percent'> | null {
  const candidates: Array<{ index: number; progress: Pick<GitCloneProgress, 'phase' | 'message' | 'percent'> }> = []
  const addPercent = (pattern: RegExp, phase: GitCloneProgress['phase'], message: string): void => {
    for (const match of value.matchAll(pattern)) {
      const percent = Number(match[1])
      if (Number.isFinite(percent)) candidates.push({
        index: match.index,
        progress: { phase, message, percent: Math.min(100, Math.max(0, percent)) }
      })
    }
  }
  addPercent(/Receiving objects:\s*(\d+)%/giu, 'receiving', 'Receiving repository objects…')
  addPercent(/Resolving deltas:\s*(\d+)%/giu, 'resolving', 'Resolving repository history…')
  addPercent(/(?:Updating files|Checking out files):\s*(\d+)%/giu, 'checking-out', 'Checking out repository files…')
  for (const match of value.matchAll(/Cloning into\s+[^\r\n]+/giu)) {
    candidates.push({ index: match.index, progress: { phase: 'starting', message: 'Connecting to the repository…' } })
  }
  return candidates.sort((left, right) => left.index - right.index).at(-1)?.progress ?? null
}

export function parseGitStatus(output: string): GitStatus {
  const records = output.split('\0').filter(Boolean)
  const header = records.shift() ?? '## HEAD'
  const branchInfo = parseBranchHeader(header)
  const changes: GitFileChange[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const indexStatus = record[0] ?? ' '
    const workingTreeStatus = record[1] ?? ' '
    const filePath = record.slice(3)
    let originalPath: string | undefined
    if (indexStatus === 'R' || indexStatus === 'C' || workingTreeStatus === 'R' || workingTreeStatus === 'C') {
      originalPath = records[index + 1]
      index += 1
    }
    changes.push({ path: filePath, originalPath, indexStatus, workingTreeStatus })
  }
  return { isRepository: true, ...branchInfo, changes }
}

export async function runGit(root: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  const shellEnvironment = await resolveShellEnvironment()
  return new Promise((resolve, reject) => {
    const allowed = new Set(options.allowedExitCodes ?? [0])
    const child = spawn('git', [
      '-c', 'color.ui=false',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      ...args
    ], {
      cwd: path.resolve(root),
      env: { ...shellEnvironment, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let aborted = options.signal?.aborted === true
    let forceKillTimer: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      if (forceKillTimer) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      if (settled) return
      aborted = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 2_000)
      forceKillTimer.unref()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const append = (target: 'stdout' | 'stderr', data: string): void => {
      if (settled) return
      if (target === 'stdout') stdout += data
      else {
        stderr += data
        options.onStderr?.(data)
      }
      if (stdout.length + stderr.length > MAX_GIT_OUTPUT) {
        settled = true
        child.kill('SIGKILL')
        cleanup()
        reject(new Error('Git produced too much output. Run the command in the terminal for more detail.'))
      }
    }
    child.stdout.on('data', (data: string) => append('stdout', data))
    child.stderr.on('data', (data: string) => append('stderr', data))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(aborted
        ? new Error('Git operation was cancelled.')
        : (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error('Git was not found. Install Xcode Command Line Tools with `xcode-select --install`.')
        : error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (aborted) reject(new Error('Git operation was cancelled.'))
      else if (code !== null && allowed.has(code)) resolve(stdout)
      else reject(new Error(redactGitOutput(stderr.trim()) || `Git exited with code ${code ?? 'unknown'}.`))
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (aborted) abort()
  })
}

export class GitManager {
  async clone(destinationParent: string, repositoryUrl: string, options: GitCloneOptions = {}): Promise<string> {
    const url = validateRepositoryUrl(repositoryUrl)
    const baseName = url.split('/').pop()?.replace(/\.git$/, '') || 'repository'
    if (!/^[\w.-]+$/.test(baseName) || baseName === '.' || baseName === '..') {
      throw new Error('The repository URL does not contain a safe folder name.')
    }
    const destination = path.join(path.resolve(destinationParent), baseName)
    let progressBuffer = ''
    let lastProgress = ''
    options.onProgress?.({ phase: 'starting', message: 'Starting Git clone…' })
    await runGit(destinationParent, ['clone', '--progress', '--', url, baseName], {
      signal: options.signal,
      onStderr: (chunk) => {
        progressBuffer = `${progressBuffer}${chunk}`.slice(-4_096)
        const progress = parseGitCloneProgress(progressBuffer)
        const key = progress ? `${progress.phase}:${progress.percent ?? ''}:${progress.message}` : ''
        if (progress && key !== lastProgress) {
          lastProgress = key
          options.onProgress?.(progress)
        }
      }
    })
    options.onProgress?.({ phase: 'completed', message: 'Repository clone completed.', percent: 100 })
    return destination
  }

  async status(root: string): Promise<GitStatus> {
    try {
      return parseGitStatus(await runGit(root, ['status', '--porcelain=v1', '--branch', '-z']))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not a git repository/i.test(message)) return { isRepository: false, branch: '', ahead: 0, behind: 0, changes: [] }
      return { isRepository: false, branch: '', ahead: 0, behind: 0, changes: [], error: message }
    }
  }

  async inspect(root: string): Promise<GitRepositoryInfo> {
    const status = await this.status(root)
    if (!status.isRepository) return { isRepository: false, branch: '', host: 'none' }
    let remoteUrl: string | undefined
    try {
      const value = (await runGit(root, ['remote', 'get-url', 'origin'])).trim()
      if (value) remoteUrl = redactGitOutput(value).slice(0, 2_048)
    } catch { /* A repository does not need an origin remote. */ }
    const github = remoteUrl
      ? /(?:^|[.@/:])github\.com(?=[:/]|$)/iu.test(remoteUrl)
      : false
    return {
      isRepository: true,
      branch: status.branch,
      ...(remoteUrl ? { remoteUrl } : {}),
      host: remoteUrl ? github ? 'github' : 'other' : 'none'
    }
  }

  async diff(root: string, filePath?: string, staged = false): Promise<string> {
    if (filePath) validatePaths([filePath])
    const args = ['diff', '--no-ext-diff', '--no-textconv']
    if (staged) args.push('--staged')
    if (filePath) args.push('--', filePath)
    const result = await runGit(root, args)
    if (result || staged || !filePath) return result
    try {
      await runGit(root, ['ls-files', '--error-unmatch', '--', filePath])
      return result
    } catch {
      return runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', filePath], { allowedExitCodes: [0, 1] })
    }
  }

  async stage(root: string, paths: string[]): Promise<void> {
    if (!paths.length) return
    validatePaths(paths)
    await runGit(root, ['add', '--all', '--', ...paths])
  }

  async unstage(root: string, paths: string[]): Promise<void> {
    if (!paths.length) return
    validatePaths(paths)
    try {
      await runGit(root, ['rev-parse', '--verify', 'HEAD'])
      await runGit(root, ['restore', '--staged', '--', ...paths])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/needed a single revision|unknown revision|bad revision|ambiguous argument/i.test(message)) throw error
      await runGit(root, ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...paths])
    }
  }

  commit(root: string, message: string): Promise<string> {
    const value = message.trim()
    if (!value) throw new Error('Enter a commit message.')
    if (value.length > 10_000 || /\0/.test(value)) throw new Error('The commit message is too long or invalid.')
    return runGit(root, ['commit', '-m', value])
  }

  operation(root: string, operation: 'init' | 'fetch' | 'pull' | 'push'): Promise<string> {
    if (operation === 'init') return runGit(root, ['init'])
    return runGit(root, [operation])
  }

  async branches(root: string): Promise<string[]> {
    const output = await runGit(root, ['branch', '--sort=-committerdate', '--format=%(refname:short)'])
    return output.split('\n').map((branch) => branch.trim()).filter(Boolean)
  }

  async switchBranch(root: string, name: string, create = false): Promise<void> {
    await this.validateBranch(root, name)
    await runGit(root, create ? ['switch', '-c', name] : ['switch', '--', name])
  }

  async deleteBranch(root: string, name: string, force = false): Promise<void> {
    await this.validateBranch(root, name)
    const status = await this.status(root)
    if (status.branch === name) throw new Error('Switch to another branch before deleting the current branch.')
    await runGit(root, ['branch', force ? '-D' : '-d', '--', name])
  }

  private async validateBranch(root: string, name: string): Promise<void> {
    const value = name.trim()
    if (!value || value.startsWith('-') || /[\r\n\0]/.test(value)) throw new Error('Enter a valid branch name.')
    await runGit(root, ['check-ref-format', '--branch', value])
  }
}
