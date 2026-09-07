import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { clipboard, shell } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import ignore from 'ignore'
import type { FileDocument, FileNode, ReplaceResult, SearchMatch, WorkspaceSearchOptions } from '../../shared/contracts'

const TREE_EXCLUSIONS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '.venv',
  'venv',
  '__pycache__'
])

const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertValidName(name: string): void {
  if (!name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error('Enter a valid file or folder name without path separators.')
  }
}

async function uniqueCopyPath(source: string): Promise<string> {
  const parsed = path.parse(source)
  let suffix = 1
  let candidate = path.join(parsed.dir, `${parsed.name} copy${parsed.ext}`)
  while (true) {
    try {
      await fs.access(candidate)
      suffix += 1
      candidate = path.join(parsed.dir, `${parsed.name} copy ${suffix}${parsed.ext}`)
    } catch {
      return candidate
    }
  }
}

export class FileSystemManager {
  private workspaceRoot: string | null = null
  private authorizedFiles = new Set<string>()
  private authorizedEntries = new Set<string>()
  private watcher: FSWatcher | null = null

  setWorkspace(root: string): string {
    const canonical = realpathSync.native(path.resolve(root))
    if (!statSync(canonical).isDirectory()) throw new Error('Choose a folder to open as a workspace.')
    this.authorizedFiles.clear()
    this.authorizedEntries.clear()
    this.workspaceRoot = canonical
    return this.workspaceRoot
  }

  getWorkspace(): string | null {
    return this.workspaceRoot
  }

  authorizeFile(target: string): string {
    const canonical = this.canonicalize(target)
    this.authorizedFiles.add(canonical)
    this.authorizedEntries.add(this.canonicalizeEntry(target))
    return canonical
  }

  /**
   * Resolve a path through the same workspace/file capability check used by
   * normal editor operations. Privileged services must call this before doing
   * their own transactional filesystem work.
   */
  resolveAuthorizedPath(target: string): string {
    return this.assertAuthorized(target)
  }

  private assertAuthorized(target: string): string {
    const resolved = this.canonicalize(target)
    if (this.authorizedFiles.has(resolved)) return resolved
    if (!this.workspaceRoot) throw new Error('Open a workspace before accessing files.')
    if (!isPathInside(this.workspaceRoot, resolved)) {
      throw new Error('OmniCode blocked access outside the current workspace. Open that folder first to grant access.')
    }
    return resolved
  }

  private canonicalize(target: string): string {
    let cursor = path.resolve(target)
    const missingSegments: string[] = []
    while (true) {
      try {
        const canonicalParent = realpathSync.native(cursor)
        return path.join(canonicalParent, ...missingSegments.reverse())
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = path.dirname(cursor)
        if (parent === cursor) throw error
        missingSegments.push(path.basename(cursor))
        cursor = parent
      }
    }
  }

  /**
   * Canonicalize every parent component while preserving the final directory
   * entry. Mutations must use this form so renaming or trashing a symlink acts
   * on the link itself instead of the file or directory it references.
   */
  private canonicalizeEntry(target: string): string {
    const resolved = path.resolve(target)
    return path.join(this.canonicalize(path.dirname(resolved)), path.basename(resolved))
  }

  private assertAuthorizedEntry(target: string): string {
    const resolved = this.canonicalizeEntry(target)
    if (this.authorizedEntries.has(resolved)) return resolved
    if (!this.workspaceRoot) throw new Error('Open a workspace before accessing files.')
    if (!isPathInside(this.workspaceRoot, resolved)) {
      throw new Error('OmniCode blocked access outside the current workspace. Open that folder first to grant access.')
    }
    return resolved
  }

  async readTree(root: string): Promise<FileNode[]> {
    const resolvedRoot = this.assertAuthorized(root)
    const walk = async (directory: string): Promise<FileNode[]> => {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      const visible = entries.filter((entry) => !TREE_EXCLUSIONS.has(entry.name))
      visible.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
      return Promise.all(
        visible.map(async (entry): Promise<FileNode> => {
          const entryPath = path.join(directory, entry.name)
          if (entry.isDirectory()) {
            return { name: entry.name, path: entryPath, kind: 'directory', children: await walk(entryPath) }
          }
          return { name: entry.name, path: entryPath, kind: 'file' }
        })
      )
    }
    return walk(resolvedRoot)
  }

  async readFile(target: string): Promise<FileDocument> {
    const safePath = this.assertAuthorized(target)
    const stats = await fs.stat(safePath)
    if (!stats.isFile()) throw new Error('The selected path is not a file.')
    if (stats.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(`This file is ${(stats.size / 1024 / 1024).toFixed(1)} MB. OmniCode limits text editing to 8 MB files.`)
    }
    const buffer = await fs.readFile(safePath)
    if (buffer.includes(0)) throw new Error('This appears to be a binary file and cannot be opened in the text editor.')
    return { path: safePath, content: buffer.toString('utf8'), modifiedAt: stats.mtimeMs, size: stats.size }
  }

  async writeFile(target: string, content: string, expectedModifiedAt?: number): Promise<FileDocument> {
    const safePath = this.assertAuthorized(target)
    await fs.mkdir(path.dirname(safePath), { recursive: true })
    const existing = await fs.stat(safePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (expectedModifiedAt !== undefined && (!existing || Math.abs(existing.mtimeMs - expectedModifiedAt) > 1)) {
      throw new Error('This file changed on disk after it was opened. Reopen it or use Save As to avoid overwriting external changes.')
    }
    const temporaryPath = `${safePath}.omnicode-${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: existing?.mode })
      if (existing) await fs.chmod(temporaryPath, existing.mode)
      await fs.rename(temporaryPath, safePath)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
    return this.readFile(safePath)
  }

  async createEntry(parent: string, name: string, kind: 'file' | 'directory'): Promise<string> {
    assertValidName(name)
    const safeParent = this.assertAuthorized(parent)
    const target = this.assertAuthorized(path.join(safeParent, name))
    if (kind === 'directory') await fs.mkdir(target)
    else await fs.writeFile(target, '', { flag: 'wx' })
    return target
  }

  async renameEntry(target: string, newName: string): Promise<string> {
    assertValidName(newName)
    const safePath = this.assertAuthorizedEntry(target)
    const destination = this.assertAuthorizedEntry(path.join(path.dirname(safePath), newName))
    if (destination === safePath) return destination
    const [sourceStats, destinationStats] = await Promise.all([
      fs.lstat(safePath),
      fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    ])
    if (destinationStats && (sourceStats.dev !== destinationStats.dev || sourceStats.ino !== destinationStats.ino)) {
      throw new Error(`“${newName}” already exists. Choose a different name before renaming this item.`)
    }
    await fs.rename(safePath, destination)
    return destination
  }

  async moveEntry(source: string, destinationDirectory: string): Promise<string> {
    const safeSource = this.assertAuthorizedEntry(source)
    const safeDestination = this.assertAuthorized(destinationDirectory)
    const destination = this.assertAuthorizedEntry(path.join(safeDestination, path.basename(safeSource)))
    if (destination === safeSource) return destination
    const destinationExists = await fs.lstat(destination).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (destinationExists) {
      throw new Error(`“${path.basename(destination)}” already exists in that folder. Rename or remove it before moving this item.`)
    }
    await fs.rename(safeSource, destination)
    return destination
  }

  async duplicateEntry(target: string): Promise<string> {
    const safePath = this.assertAuthorized(target)
    const destination = this.assertAuthorized(await uniqueCopyPath(safePath))
    await fs.cp(safePath, destination, { recursive: true, errorOnExist: true })
    return destination
  }

  async trashEntry(target: string): Promise<void> {
    const safePath = this.assertAuthorizedEntry(target)
    if (safePath === this.workspaceRoot) throw new Error('Close the workspace before removing its root folder.')
    await shell.trashItem(safePath)
  }

  async revealInFinder(target: string): Promise<void> {
    const safePath = this.assertAuthorized(target)
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/open', ['-R', safePath], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`macOS could not reveal the item in Finder (exit ${code}).`)))
    })
  }

  copyPath(target: string): void {
    clipboard.writeText(this.assertAuthorized(target))
  }

  async openExternal(target: string): Promise<string> {
    return shell.openPath(this.assertAuthorized(target))
  }

  async openWith(target: string, applicationPath: string): Promise<void> {
    const safePath = this.assertAuthorized(target)
    if (!applicationPath.endsWith('.app')) throw new Error('Choose a macOS application bundle.')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/open', ['-a', applicationPath, safePath], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`macOS could not open the file with that application (exit ${code}).`)))
    })
  }

  async search(root: string, query: string, options: WorkspaceSearchOptions = {}): Promise<SearchMatch[]> {
    if (!query.trim()) return []
    if (Buffer.byteLength(query, 'utf8') > 64 * 1024) throw new Error('The workspace search query is too large.')
    if ((options.include?.length ?? 0) > 16_384 || (options.exclude?.length ?? 0) > 16_384) {
      throw new Error('The workspace include or exclude pattern is too large.')
    }
    const safeRoot = this.assertAuthorized(root)
    const hasOmniCodeIgnore = await fs.access(path.join(safeRoot, '.omnicodeignore')).then(() => true).catch(() => false)
    return new Promise((resolve, reject) => {
      const args = [
        '--json', '--line-number', '--column', '--hidden',
        '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**', '--glob', '!build/**',
        '--max-filesize', '8M'
      ]
      if (hasOmniCodeIgnore) args.push('--ignore-file', '.omnicodeignore')
      if (!options.regex) args.push('--fixed-strings')
      if (options.caseSensitive) args.push('--case-sensitive')
      else args.push('--ignore-case')
      if (options.wholeWord) args.push('--word-regexp')
      if (options.include?.trim()) args.push('--glob', options.include.trim())
      if (options.exclude?.trim()) {
        for (const pattern of options.exclude.split(',').map((item) => item.trim()).filter(Boolean)) args.push('--glob', `!${pattern}`)
      }
      args.push('--', query, '.')
      const child = spawn('rg', args, { cwd: safeRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      const matches: SearchMatch[] = []
      let stdout = ''
      let stderr = ''
      let usingFallback = false
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
        const lines = stdout.split('\n')
        stdout = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          try {
            const event = JSON.parse(line) as {
              type: string
              data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: Array<{ start: number }> }
            }
            if (event.type !== 'match' || !event.data?.path?.text) continue
            if (matches.length < 2_000) {
              matches.push({
                path: path.join(safeRoot, event.data.path.text),
                line: event.data.line_number ?? 1,
                column: (event.data.submatches?.[0]?.start ?? 0) + 1,
                preview: event.data.lines?.text?.trimEnd() ?? ''
              })
            }
          } catch {
            // Ignore malformed rg events while preserving valid results.
          }
        }
      })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          usingFallback = true
          void this.searchWithoutRipgrep(safeRoot, query, options).then(resolve, reject)
        } else reject(error)
      })
      child.on('close', (code) => {
        if (usingFallback) return
        if (code === 0 || code === 1) resolve(matches.slice(0, 2_000))
        else reject(new Error(stderr.trim() || `Workspace search exited with code ${code}.`))
      })
    })
  }

  private async searchWithoutRipgrep(root: string, query: string, options: WorkspaceSearchOptions): Promise<SearchMatch[]> {
    let expression: RegExp
    try {
      const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expression = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? 'u' : 'iu')
    } catch (error) {
      throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
    }

    const matcher = ignore().add([...TREE_EXCLUSIONS].map((entry) => `${entry}/`))
    for (const ignoreFile of ['.gitignore', '.omnicodeignore']) {
      try { matcher.add(await fs.readFile(path.join(root, ignoreFile), 'utf8')) } catch { /* optional */ }
    }
    if (options.exclude?.trim()) {
      matcher.add(options.exclude.split(',').map((item) => item.trim()).filter(Boolean))
    }
    const includePatterns = options.include?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
    const matchesInclude = (relativePath: string): boolean => !includePatterns.length || includePatterns.some((pattern) => {
      try { return path.matchesGlob(relativePath, pattern) || path.matchesGlob(path.basename(relativePath), pattern) }
      catch { return relativePath.includes(pattern) }
    })

    const results: SearchMatch[] = []
    const directories = ['']
    let filesVisited = 0
    while (directories.length && results.length < 2_000 && filesVisited < 20_000) {
      const relativeDirectory = directories.pop() ?? ''
      let entries: import('node:fs').Dirent<string>[]
      try { entries = await fs.readdir(path.join(root, relativeDirectory), { withFileTypes: true, encoding: 'utf8' }) }
      catch { continue }
      for (const entry of entries) {
        const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name)
        const ignorePath = entry.isDirectory() ? `${relativePath}/` : relativePath
        if (matcher.ignores(ignorePath) || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          directories.push(relativePath)
          continue
        }
        if (!entry.isFile() || !matchesInclude(relativePath)) continue
        filesVisited += 1
        try {
          const absolutePath = path.join(root, relativePath)
          const stats = await fs.stat(absolutePath)
          if (stats.size > MAX_TEXT_FILE_BYTES) continue
          const buffer = await fs.readFile(absolutePath)
          if (buffer.includes(0)) continue
          const lines = buffer.toString('utf8').split(/\r?\n/u)
          for (let index = 0; index < lines.length && results.length < 2_000; index += 1) {
            const match = expression.exec(lines[index])
            if (!match) continue
            results.push({ path: absolutePath, line: index + 1, column: (match.index ?? 0) + 1, preview: lines[index] })
          }
        } catch { /* files can disappear during a search */ }
      }
    }
    return results
  }

  async replaceAll(root: string, query: string, replacement: string, options: WorkspaceSearchOptions = {}): Promise<ReplaceResult> {
    if (!query) throw new Error('Enter text to replace.')
    const matches = await this.search(root, query, options)
    const paths = [...new Set(matches.map((match) => match.path))]
    let filesChanged = 0
    let replacements = 0
    let expression: RegExp
    try {
      const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expression = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? 'g' : 'gi')
    } catch (error) {
      throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const filePath of paths) {
      const document = await this.readFile(filePath)
      let count = 0
      const content = document.content.replace(expression, (...args: unknown[]) => {
        count += 1
        if (!options.regex) return replacement
        const matched = String(args[0])
        return matched.replace(new RegExp(expression.source, options.caseSensitive ? '' : 'i'), replacement)
      })
      if (!count || content === document.content) continue
      await this.writeFile(filePath, content, document.modifiedAt)
      filesChanged += 1
      replacements += count
    }
    return { filesChanged, replacements }
  }

  async watch(root: string, onChanged: (changedPath: string) => void): Promise<void> {
    await this.unwatch()
    const safeRoot = this.assertAuthorized(root)
    this.watcher = chokidar.watch(safeRoot, {
      ignoreInitial: true,
      ignored: (watchedPath) => watchedPath.split(path.sep).some((segment) => TREE_EXCLUSIONS.has(segment)),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })
    this.watcher.on('all', (_event, changedPath) => onChanged(changedPath))
  }

  async unwatch(): Promise<void> {
    if (this.watcher) await this.watcher.close()
    this.watcher = null
  }
}
