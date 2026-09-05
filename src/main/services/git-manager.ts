import { spawn } from 'node:child_process'
import path from 'node:path'

import type { GitFileChange, GitStatus } from '../../shared/contracts'
import { resolveShellEnvironment } from './shell-environment'

const MAX_GIT_OUTPUT = 16 * 1024 * 1024

interface GitRunOptions {
  allowedExitCodes?: number[]
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

function parseBranchHeader(header: string): { branch: string; ahead: number; behind: number } {
  const details = header.replace(/^## /, '')
  const ahead = Number(details.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(details.match(/behind (\d+)/)?.[1] ?? 0)
  if (details.startsWith('No commits yet on ')) return { branch: details.slice('No commits yet on '.length), ahead, behind }
  if (details.startsWith('Initial commit on ')) return { branch: details.slice('Initial commit on '.length), ahead, behind }
  if (details.startsWith('HEAD (no branch)')) return { branch: 'HEAD', ahead, behind }
  return { branch: details.split('...')[0]?.trim() || 'HEAD', ahead, behind }
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
    if (indexStatus === 'R' || indexStatus === 'C') {
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
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const append = (target: 'stdout' | 'stderr', data: string): void => {
      if (settled) return
      if (target === 'stdout') stdout += data
      else stderr += data
      if (stdout.length + stderr.length > MAX_GIT_OUTPUT) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error('Git produced too much output. Run the command in the terminal for more detail.'))
      }
    }
    child.stdout.on('data', (data: string) => append('stdout', data))
    child.stderr.on('data', (data: string) => append('stderr', data))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error('Git was not found. Install Xcode Command Line Tools with `xcode-select --install`.')
        : error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code !== null && allowed.has(code)) resolve(stdout)
      else reject(new Error(stderr.trim() || `Git exited with code ${code ?? 'unknown'}.`))
    })
  })
}

export class GitManager {
  async clone(destinationParent: string, repositoryUrl: string): Promise<string> {
    const url = repositoryUrl.trim()
    if (!url || url.startsWith('-') || /[\r\n\0]/.test(url)) throw new Error('Enter a valid Git repository URL.')
    const baseName = url.split('/').pop()?.replace(/\.git$/, '') || 'repository'
    if (!/^[\w.-]+$/.test(baseName) || baseName === '.' || baseName === '..') {
      throw new Error('The repository URL does not contain a safe folder name.')
    }
    await runGit(destinationParent, ['clone', '--', url, baseName])
    return path.join(path.resolve(destinationParent), baseName)
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
