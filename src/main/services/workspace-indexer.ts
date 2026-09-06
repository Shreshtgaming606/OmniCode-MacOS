import { promises as fs } from 'node:fs'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import type { WorkspaceIndexStatus } from '../../shared/contracts'
import { isPathInside } from './filesystem-manager'
import { isSensitiveRelativePath } from './sensitive-paths'
import { readBoundedTextFile, workspaceMetadataFile, workspaceRootFile } from './workspace-metadata'

const DEFAULT_IGNORES = [
  '.git/', '.hg/', '.svn/', '.omnicode/', '.ssh/', '.aws/', '.gnupg/',
  'node_modules/', 'dist/', 'build/', '.next/', '.cache/', '.venv/', 'venv/', '__pycache__/',
  '.env', '.env.*', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', '.netrc', '.pypirc',
  'credentials', 'credentials.*', 'secret', 'secret.*', 'secrets', 'secrets.*',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '*.pem', '*.key', '*.p12', '*.pfx',
  '*.jks', '*.keystore', '*.kdbx', '*.mobileprovision',
  '*.lock', '*.min.js', '*.map', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.ico', '*.pdf', '*.zip',
  '*.tar', '*.gz', '*.dmg', '*.app/', '*.o', '*.a', '*.so', '*.dylib', '*.class', '*.pyc'
]

const TEXT_EXTENSIONS = new Set([
  '', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.m', '.mm', '.swift', '.cs', '.go', '.rs', '.java', '.kt',
  '.py', '.rb', '.php', '.lua', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html', '.css', '.scss',
  '.json', '.jsonc', '.xml', '.yaml', '.yml', '.toml', '.ini', '.md', '.mdx', '.sql', '.sh', '.zsh', '.fish',
  '.dockerfile', '.gradle', '.properties', '.txt'
])

const MAX_INDEXED_FILES = 4_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_CONTENT_BYTES = 32 * 1024 * 1024
const MAX_TOKENS_PER_FILE = 25_000
const MAX_IGNORE_BYTES = 256 * 1024

export interface IndexedFile {
  path: string
  relativePath: string
  content: string
  symbols: string[]
  imports: string[]
  tokens: Set<string>
}

export function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z_$][\w$-]{1,}/g)?.filter((token) => !STOP_WORDS.has(token)) ?? []
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'const', 'let', 'var', 'function', 'class', 'return'])

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>()
  const expressions = [
    /\b(?:class|interface|enum|struct|func|function|def|fn)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g
  ]
  for (const expression of expressions) {
    for (const match of content.matchAll(expression)) if (match[1]) symbols.add(match[1])
  }
  return [...symbols].slice(0, 200)
}

function extractImports(content: string): string[] {
  const imports = new Set<string>()
  const expression = /(?:from\s+|require\s*\(\s*|import\s+)["']([^"']+)["']/g
  for (const match of content.matchAll(expression)) if (match[1]) imports.add(match[1])
  return [...imports].slice(0, 100)
}

export function rankIndexedFile(file: IndexedFile, queryTokens: string[]): number {
  const pathTokens = new Set(tokenize(file.relativePath))
  const symbolTokens = new Set(file.symbols.flatMap(tokenize))
  let score = 0
  for (const token of queryTokens) {
    if (pathTokens.has(token)) score += 8
    if (symbolTokens.has(token)) score += 6
    if (file.tokens.has(token)) score += 1
  }
  if (score > 0 && /readme|package\.json|cargo\.toml|omnicode\.json/i.test(file.relativePath)) score += 0.5
  return score
}

export class WorkspaceIndexer {
  private root: string | null = null
  private files = new Map<string, IndexedFile>()
  private ignoredCount = 0
  private indexedAt = 0
  private generation = 0

  async index(root: string): Promise<WorkspaceIndexStatus> {
    const generation = ++this.generation
    const nextRoot = path.resolve(root)
    const nextFiles = new Map<string, IndexedFile>()
    let nextIgnoredCount = 0
    let indexedBytes = 0
    let processedEntries = 0
    const matcher = await this.buildIgnoreMatcher(nextRoot)
    const pending = ['']
    while (pending.length && nextFiles.size < MAX_INDEXED_FILES) {
      if (generation !== this.generation) return this.status()
      const relativeDirectory = pending.pop() ?? ''
      const absoluteDirectory = path.join(nextRoot, relativeDirectory)
      let entries: import('node:fs').Dirent<string>[]
      try {
        entries = await fs.readdir(absoluteDirectory, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        nextIgnoredCount += 1
        continue
      }
      for (const entry of entries) {
        if (generation !== this.generation) return this.status()
        processedEntries += 1
        if (processedEntries % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name)
        const ignorePath = entry.isDirectory() ? `${relativePath}/` : relativePath
        if (isSensitiveRelativePath(relativePath) || matcher.ignores(ignorePath)) {
          nextIgnoredCount += 1
          continue
        }
        if (entry.isDirectory()) {
          pending.push(relativePath)
          continue
        }
        if (!entry.isFile() || !this.isTextCandidate(entry.name)) continue
        const absolutePath = path.join(nextRoot, relativePath)
        try {
          const stats = await fs.stat(absolutePath)
          if (stats.size > MAX_FILE_BYTES || indexedBytes + stats.size > MAX_TOTAL_CONTENT_BYTES) {
            nextIgnoredCount += 1
            continue
          }
          const buffer = await fs.readFile(absolutePath)
          if (buffer.includes(0)) continue
          const content = buffer.toString('utf8')
          indexedBytes += buffer.byteLength
          nextFiles.set(absolutePath, {
            path: absolutePath,
            relativePath,
            content,
            symbols: extractSymbols(content),
            imports: extractImports(content),
            tokens: new Set(tokenize(`${relativePath} ${content}`).slice(0, MAX_TOKENS_PER_FILE))
          })
        } catch {
          nextIgnoredCount += 1
        }
      }
    }
    if (generation !== this.generation) return this.status()
    this.root = nextRoot
    this.files = nextFiles
    this.ignoredCount = nextIgnoredCount
    this.indexedAt = Date.now()
    return this.status()
  }

  status(): WorkspaceIndexStatus {
    return { fileCount: this.files.size, ignoredCount: this.ignoredCount, indexedAt: this.indexedAt }
  }

  relevant(query: string, limit = 8, expectedRoot?: string): IndexedFile[] {
    if (expectedRoot && (!this.root || path.resolve(expectedRoot) !== this.root)) return []
    const queryTokens = tokenize(query)
    return [...this.files.values()]
      .map((file) => ({ file, score: rankIndexedFile(file, queryTokens) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((result) => result.file)
  }

  async readAttached(paths: string[]): Promise<IndexedFile[]> {
    const result: IndexedFile[] = []
    for (const requestedPath of paths.slice(0, 20)) {
      const absolutePath = path.resolve(requestedPath)
      try {
        const buffer = await fs.readFile(absolutePath)
        if (buffer.byteLength > MAX_FILE_BYTES || buffer.includes(0)) continue
        const content = buffer.toString('utf8')
        result.push({
          path: absolutePath,
          relativePath: this.root && isPathInside(this.root, absolutePath)
            ? path.relative(this.root, absolutePath)
            : path.basename(absolutePath),
          content,
          symbols: extractSymbols(content),
          imports: extractImports(content),
          tokens: new Set(tokenize(content))
        })
      } catch {
        // Ignore inaccessible attachments rather than expanding permissions.
      }
    }
    return result
  }

  private isTextCandidate(name: string): boolean {
    const lower = name.toLowerCase()
    return TEXT_EXTENSIONS.has(path.extname(lower)) || ['dockerfile', 'makefile', 'gemfile', 'rakefile'].includes(lower)
  }

  private async buildIgnoreMatcher(root: string): Promise<Ignore> {
    const matcher = ignore().add(DEFAULT_IGNORES)
    try {
      const target = await workspaceRootFile(root, '.gitignore')
      if (target) matcher.add(await readBoundedTextFile(target, MAX_IGNORE_BYTES, '.gitignore'))
    } catch { /* optional */ }
    try {
      const target = await workspaceRootFile(root, '.omnicodeignore')
      if (target) matcher.add(await readBoundedTextFile(target, MAX_IGNORE_BYTES, '.omnicodeignore'))
    } catch { /* optional */ }
    try {
      const settings = JSON.parse(await readBoundedTextFile(await workspaceMetadataFile(root, 'settings.json'), MAX_IGNORE_BYTES, '.omnicode/settings.json')) as {
        ai?: { exclusions?: unknown }
      }
      if (Array.isArray(settings.ai?.exclusions)) {
        matcher.add(settings.ai.exclusions.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))
      }
    } catch { /* optional or invalid settings are reported by SettingsManager */ }
    return matcher
  }
}
