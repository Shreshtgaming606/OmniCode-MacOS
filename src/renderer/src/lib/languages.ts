import type { FileNode } from '../../../shared/contracts'

/**
 * How OmniCode can execute a file or project associated with a language.
 *
 * `project` means the file is not normally launched on its own, but the Run
 * view can start its containing project (for example a Vue or Gradle project).
 * `platform-specific` is intentionally not runnable on macOS by default.
 */
export type LanguageExecutionKind =
  | 'none'
  | 'interpreted'
  | 'compiled'
  | 'project'
  | 'preview'
  | 'platform-specific'

/**
 * Whether Monaco has an exact built-in grammar, a shared compatible grammar,
 * or a best-effort fallback for the language.
 */
export type MonacoSyntaxSupport = 'native' | 'compatible' | 'fallback'

export type LanguageId =
  | 'html'
  | 'css'
  | 'scss'
  | 'less'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'c'
  | 'cpp'
  | 'objective-c'
  | 'objective-cpp'
  | 'swift'
  | 'csharp'
  | 'rust'
  | 'go'
  | 'php'
  | 'ruby'
  | 'kotlin'
  | 'lua'
  | 'json'
  | 'xml'
  | 'yaml'
  | 'markdown'
  | 'mdx'
  | 'sql'
  | 'shell'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'dockerfile'
  | 'toml'
  | 'ini'
  | 'makefile'
  | 'gradle'
  | 'jsx'
  | 'tsx'
  | 'vue'
  | 'svelte'
  | 'powershell'
  | 'batch'
  | 'plaintext'

export interface LanguageDefinition {
  /** Stable OmniCode identifier. */
  readonly id: LanguageId
  readonly displayName: string
  /** Identifier accepted by Monaco's `language` editor option. */
  readonly monacoLanguageId: string
  /** Lowercase suffixes, including the leading dot. */
  readonly extensions: readonly string[]
  /** Case-insensitive exact basenames. */
  readonly filenames: readonly string[]
  readonly executionKind: LanguageExecutionKind
  readonly runnableOnMacOS: boolean
  readonly monacoSyntaxSupport: MonacoSyntaxSupport
}

const language = (
  id: LanguageId,
  displayName: string,
  monacoLanguageId: string,
  extensions: readonly string[],
  executionKind: LanguageExecutionKind,
  runnableOnMacOS: boolean,
  options: {
    filenames?: readonly string[]
    monacoSyntaxSupport?: MonacoSyntaxSupport
  } = {}
): LanguageDefinition => ({
  id,
  displayName,
  monacoLanguageId,
  extensions,
  filenames: options.filenames ?? [],
  executionKind,
  runnableOnMacOS,
  monacoSyntaxSupport: options.monacoSyntaxSupport ?? 'native'
})

/**
 * The complete language catalog used by the editor. Keep detection data here
 * rather than scattering extension checks throughout React components.
 *
 * Monaco does not ship exact grammars for TOML, Makefile, Gradle, Vue, or
 * Svelte. Those entries deliberately identify the closest bundled grammar and
 * mark it as a fallback so a future language contribution can replace it in a
 * single place.
 */
export const LANGUAGE_DEFINITIONS: readonly LanguageDefinition[] = [
  language('html', 'HTML', 'html', ['.html', '.htm', '.xhtml'], 'preview', true),
  language('css', 'CSS', 'css', ['.css'], 'none', false),
  language('scss', 'SCSS', 'scss', ['.scss'], 'none', false),
  language('less', 'Less', 'less', ['.less'], 'none', false),
  language(
    'javascript',
    'JavaScript',
    'javascript',
    ['.js', '.mjs', '.cjs'],
    'interpreted',
    true,
    { filenames: ['jakefile'] }
  ),
  language(
    'typescript',
    'TypeScript',
    'typescript',
    ['.ts', '.mts', '.cts'],
    'interpreted',
    true
  ),
  language(
    'python',
    'Python',
    'python',
    ['.py', '.pyw', '.pyi'],
    'interpreted',
    true,
    { filenames: ['sconstruct', 'sconscript'] }
  ),
  language('java', 'Java', 'java', ['.java'], 'compiled', true),
  language('c', 'C', 'cpp', ['.c', '.h'], 'compiled', true, {
    monacoSyntaxSupport: 'compatible'
  }),
  language(
    'cpp',
    'C++',
    'cpp',
    ['.cc', '.cpp', '.cxx', '.c++', '.cp', '.hh', '.hpp', '.hxx', '.h++', '.ipp', '.tpp'],
    'compiled',
    true
  ),
  language('objective-c', 'Objective-C', 'objective-c', ['.m'], 'compiled', true),
  language('objective-cpp', 'Objective-C++', 'objective-c', ['.mm'], 'compiled', true, {
    monacoSyntaxSupport: 'compatible'
  }),
  language('swift', 'Swift', 'swift', ['.swift'], 'compiled', true),
  language('csharp', 'C#', 'csharp', ['.cs', '.csx'], 'compiled', true),
  language('rust', 'Rust', 'rust', ['.rs'], 'compiled', true),
  language('go', 'Go', 'go', ['.go'], 'compiled', true),
  language(
    'php',
    'PHP',
    'php',
    ['.php', '.php3', '.php4', '.php5', '.phtml', '.phps'],
    'interpreted',
    true
  ),
  language(
    'ruby',
    'Ruby',
    'ruby',
    ['.rb', '.rake', '.gemspec'],
    'interpreted',
    true,
    { filenames: ['gemfile', 'rakefile', 'guardfile', 'podfile', 'fastfile', 'brewfile'] }
  ),
  language('kotlin', 'Kotlin', 'kotlin', ['.kt', '.kts'], 'compiled', true),
  language('lua', 'Lua', 'lua', ['.lua'], 'interpreted', true),
  language('json', 'JSON', 'json', ['.json', '.jsonc', '.json5'], 'none', false, {
    filenames: ['.eslintrc', '.prettierrc', '.babelrc', '.swcrc']
  }),
  language(
    'xml',
    'XML',
    'xml',
    ['.xml', '.xsd', '.xsl', '.xslt', '.svg', '.plist'],
    'none',
    false
  ),
  language('yaml', 'YAML', 'yaml', ['.yaml', '.yml'], 'none', false, {
    filenames: ['.clang-format', '.clang-tidy']
  }),
  language(
    'markdown',
    'Markdown',
    'markdown',
    ['.md', '.markdown', '.mdown', '.mkd'],
    'none',
    false,
    { filenames: ['readme', 'changelog', 'contributing'] }
  ),
  language('mdx', 'MDX', 'mdx', ['.mdx'], 'none', false),
  language('sql', 'SQL', 'sql', ['.sql'], 'none', false),
  language('shell', 'Shell', 'shell', ['.sh'], 'interpreted', true, {
    filenames: ['.profile', '.shrc', 'gradlew', 'mvnw']
  }),
  language('bash', 'Bash', 'shell', ['.bash'], 'interpreted', true, {
    filenames: ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout'],
    monacoSyntaxSupport: 'compatible'
  }),
  language('zsh', 'zsh', 'shell', ['.zsh'], 'interpreted', true, {
    filenames: ['.zshrc', '.zprofile', '.zlogin', '.zlogout', '.zshenv'],
    monacoSyntaxSupport: 'compatible'
  }),
  language('fish', 'Fish', 'shell', ['.fish'], 'interpreted', true, {
    monacoSyntaxSupport: 'compatible'
  }),
  language('dockerfile', 'Dockerfile', 'dockerfile', ['.dockerfile'], 'project', true, {
    filenames: ['dockerfile', 'containerfile']
  }),
  language('toml', 'TOML', 'ini', ['.toml'], 'none', false, {
    monacoSyntaxSupport: 'fallback'
  }),
  language(
    'ini',
    'INI',
    'ini',
    ['.ini', '.cfg', '.conf', '.properties'],
    'none',
    false,
    {
      filenames: ['.editorconfig', '.gitconfig', '.npmrc', '.yarnrc', '.buckconfig']
    }
  ),
  language(
    'makefile',
    'Makefile',
    'shell',
    ['.mk', '.mak', '.make'],
    'project',
    true,
    {
      filenames: ['makefile', 'gnumakefile', 'bsdmakefile'],
      monacoSyntaxSupport: 'fallback'
    }
  ),
  language('gradle', 'Gradle', 'java', ['.gradle'], 'project', true, {
    monacoSyntaxSupport: 'fallback'
  }),
  language('jsx', 'JSX', 'javascript', ['.jsx'], 'project', true, {
    monacoSyntaxSupport: 'compatible'
  }),
  language('tsx', 'TSX', 'typescript', ['.tsx'], 'project', true, {
    monacoSyntaxSupport: 'compatible'
  }),
  language('vue', 'Vue', 'html', ['.vue'], 'project', true, {
    monacoSyntaxSupport: 'fallback'
  }),
  language('svelte', 'Svelte', 'html', ['.svelte'], 'project', true, {
    monacoSyntaxSupport: 'fallback'
  }),
  language(
    'powershell',
    'PowerShell',
    'powershell',
    ['.ps1', '.psm1', '.psd1'],
    'platform-specific',
    false
  ),
  language(
    'batch',
    'Windows Batch',
    'bat',
    ['.bat', '.cmd'],
    'platform-specific',
    false
  ),
  language('plaintext', 'Plain Text', 'plaintext', ['.txt', '.text', '.log'], 'none', false)
]

const definitionById = new Map<LanguageId, LanguageDefinition>()
const definitionByExtension = new Map<string, LanguageDefinition>()
const definitionByFilename = new Map<string, LanguageDefinition>()

for (const definition of LANGUAGE_DEFINITIONS) {
  definitionById.set(definition.id, definition)
  for (const extension of definition.extensions) {
    definitionByExtension.set(extension.toLowerCase(), definition)
  }
  for (const filename of definition.filenames) {
    definitionByFilename.set(filename.toLowerCase(), definition)
  }
}

const fallbackLanguage = definitionById.get('plaintext')!

interface FilenamePattern {
  readonly pattern: RegExp
  readonly languageId: LanguageId
}

/** Rules for filename families whose names may contain an environment suffix. */
const filenamePatterns: readonly FilenamePattern[] = [
  { pattern: /^(?:dockerfile|containerfile)(?:\..+)?$/i, languageId: 'dockerfile' },
  { pattern: /^.+\.(?:dockerfile|containerfile)$/i, languageId: 'dockerfile' },
  { pattern: /^(?:(?:gnu|bsd)?makefile)(?:\..+)?$/i, languageId: 'makefile' },
  { pattern: /^\.env(?:\..+)?$/i, languageId: 'shell' }
]

export function fileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/g, '')
  if (!normalized) return ''
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Returns a normalized extension, or an empty string for extensionless dotfiles. */
export function fileExtension(filePath: string): string {
  const name = fileName(filePath)
  const index = name.lastIndexOf('.')
  if (index <= 0) return ''
  return name.slice(index).toLowerCase()
}

export function getLanguageDefinition(languageId: LanguageId): LanguageDefinition {
  return definitionById.get(languageId) ?? fallbackLanguage
}

/**
 * Detects the semantic language for a path. Basename rules run before suffix
 * rules so `Dockerfile.dev` and `Makefile.release` are recognized correctly.
 */
export function languageDefinitionForPath(filePath: string): LanguageDefinition {
  const name = fileName(filePath)
  if (!name) return fallbackLanguage

  // Uppercase .M and .C have distinct compiler meanings on Unix toolchains.
  if (name.endsWith('.M')) return getLanguageDefinition('objective-cpp')
  if (name.endsWith('.C')) return getLanguageDefinition('cpp')

  const normalizedName = name.toLowerCase()
  const exact = definitionByFilename.get(normalizedName)
  if (exact) return exact

  const patterned = filenamePatterns.find(({ pattern }) => pattern.test(name))
  if (patterned) return getLanguageDefinition(patterned.languageId)

  return definitionByExtension.get(fileExtension(name)) ?? fallbackLanguage
}

/** Stable OmniCode language identifier for a file path. */
export function languageIdForPath(filePath: string): LanguageId {
  return languageDefinitionForPath(filePath).id
}

/** Monaco-compatible language identifier retained for existing editor callers. */
export function languageForPath(filePath: string): string {
  return languageDefinitionForPath(filePath).monacoLanguageId
}

export const monacoLanguageForPath = languageForPath

export function displayNameForPath(filePath: string): string {
  return languageDefinitionForPath(filePath).displayName
}

export function isRunnableLanguage(languageId: LanguageId): boolean {
  return getLanguageDefinition(languageId).runnableOnMacOS
}

export function isRunnablePath(filePath: string): boolean {
  return languageDefinitionForPath(filePath).runnableOnMacOS
}

export function flattenFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) =>
    node.kind === 'file' ? [node] : flattenFiles(node.children ?? [])
  )
}
