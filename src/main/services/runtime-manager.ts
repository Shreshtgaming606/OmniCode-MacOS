import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import type { ToolInfo } from '../../shared/contracts'
import { resolveShellEnvironment } from './shell-environment'

const DEFAULT_TIMEOUT_MS = 4_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export const HOMEBREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] as const

export type RuntimeToolId =
  | 'xcode'
  | 'xcode-command-line-tools'
  | 'homebrew'
  | 'git'
  | 'python3'
  | 'python'
  | 'node'
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'bun'
  | 'deno'
  | 'java'
  | 'javac'
  | 'clang'
  | 'clang++'
  | 'swift'
  | 'swiftc'
  | 'dotnet'
  | 'rustc'
  | 'cargo'
  | 'go'
  | 'ruby'
  | 'php'
  | 'lua'
  | 'kotlinc'
  | 'gradle'
  | 'make'
  | 'docker'
  | 'ollama'
  | 'bash'
  | 'zsh'
  | 'fish'

// These /usr/bin entries are Apple launchers, not proof that their toolchain
// exists. Invoking one on a fresh Mac can open the CLT installation dialog.
const APPLE_DEVELOPER_SHIM_TOOLS = new Set<RuntimeToolId>([
  'xcode', 'git', 'python3', 'clang', 'clang++', 'swift', 'swiftc', 'make'
])

export interface InstallationGuidance {
  message: string
  command?: string
  url?: string
}

export interface RuntimeToolDefinition {
  id: RuntimeToolId
  name: string
  command: string
  aliases?: readonly string[]
  knownPaths?: readonly string[]
  probeArgs: readonly string[]
  guidance: InstallationGuidance
  /** Some macOS commands are shims, so a failed probe means the tool is unavailable. */
  requireSuccessfulProbe?: boolean
  probeOutputIsDetail?: boolean
}

export interface RuntimeToolInfo extends ToolInfo {
  id: RuntimeToolId
  detectedPaths: string[]
  installation?: InstallationGuidance
  diagnostic?: string
  details?: string
}

export interface CommandExecutionOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface CommandExecutionResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  errorCode?: string
  signal?: NodeJS.Signals
}

export type SafeCommandRunner = (
  executable: string,
  args?: readonly string[],
  options?: CommandExecutionOptions
) => Promise<CommandExecutionResult>

export type ExecutableAccessCheck = (path: string) => Promise<boolean>

export interface RuntimeManagerOptions {
  runner?: SafeCommandRunner
  isExecutable?: ExecutableAccessCheck
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  timeoutMs?: number
}

function brewPaths(command: string): string[] {
  return [`/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`]
}

function guidance(
  message: string,
  command?: string,
  url?: string
): InstallationGuidance {
  return { message, command, url }
}

export const RUNTIME_TOOL_DEFINITIONS: readonly RuntimeToolDefinition[] = [
  {
    id: 'xcode',
    name: 'Xcode',
    command: 'xcodebuild',
    knownPaths: ['/usr/bin/xcodebuild', '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild'],
    probeArgs: ['-version'],
    requireSuccessfulProbe: true,
    guidance: guidance(
      'Full Xcode is optional and is useful for Apple-platform application projects.',
      undefined,
      'https://developer.apple.com/xcode/'
    )
  },
  {
    id: 'xcode-command-line-tools',
    name: 'Xcode Command Line Tools',
    command: 'xcode-select',
    knownPaths: ['/usr/bin/xcode-select'],
    probeArgs: ['-p'],
    requireSuccessfulProbe: true,
    probeOutputIsDetail: true,
    guidance: guidance(
      "Apple's compiler toolchain is required for C, C++, Objective-C, Swift, and native packages.",
      'xcode-select --install',
      'https://developer.apple.com/xcode/resources/'
    )
  },
  {
    id: 'homebrew',
    name: 'Homebrew',
    command: 'brew',
    knownPaths: HOMEBREW_PATHS,
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance(
      'Homebrew is optional, but it is the most common way to install development tools on macOS.',
      undefined,
      'https://brew.sh/'
    )
  },
  {
    id: 'git',
    name: 'Git',
    command: 'git',
    knownPaths: ['/usr/bin/git', ...brewPaths('git')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Git is required for source-control features.', 'xcode-select --install', 'https://git-scm.com/download/mac')
  },
  {
    id: 'python3',
    name: 'Python 3',
    command: 'python3',
    knownPaths: ['/usr/bin/python3', ...brewPaths('python3')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Python 3 is required to run Python projects.', 'brew install python', 'https://www.python.org/downloads/macos/')
  },
  {
    id: 'python',
    name: 'Python (python alias)',
    command: 'python',
    knownPaths: brewPaths('python'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('The optional python alias is not available; OmniCode uses Python 3 directly. Install Python 3 above if needed.')
  },
  {
    id: 'node',
    name: 'Node.js',
    command: 'node',
    knownPaths: brewPaths('node'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Node.js is required to run JavaScript and many TypeScript projects.', 'brew install node', 'https://nodejs.org/en/download')
  },
  {
    id: 'npm',
    name: 'npm',
    command: 'npm',
    knownPaths: brewPaths('npm'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('npm is normally installed with Node.js.', 'brew install node', 'https://nodejs.org/en/download')
  },
  {
    id: 'yarn',
    name: 'Yarn',
    command: 'yarn',
    knownPaths: brewPaths('yarn'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Yarn is optional and only needed by projects that use it.', 'brew install yarn', 'https://yarnpkg.com/getting-started/install')
  },
  {
    id: 'pnpm',
    name: 'pnpm',
    command: 'pnpm',
    knownPaths: brewPaths('pnpm'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('pnpm is optional and only needed by projects that use it.', 'brew install pnpm', 'https://pnpm.io/installation')
  },
  {
    id: 'bun',
    name: 'Bun',
    command: 'bun',
    knownPaths: brewPaths('bun'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Bun is optional and only needed by projects that use it.', 'brew install oven-sh/bun/bun', 'https://bun.sh/docs/installation')
  },
  {
    id: 'deno',
    name: 'Deno',
    command: 'deno',
    knownPaths: brewPaths('deno'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Deno is optional and only needed by Deno projects.', 'brew install deno', 'https://docs.deno.com/runtime/getting_started/installation/')
  },
  {
    id: 'java',
    name: 'Java Runtime',
    command: 'java',
    knownPaths: ['/usr/bin/java', ...brewPaths('java')],
    probeArgs: ['-version'],
    requireSuccessfulProbe: true,
    guidance: guidance('A JDK is required to run Java projects.', 'brew install --cask temurin', 'https://adoptium.net/temurin/releases/')
  },
  {
    id: 'javac',
    name: 'Java Compiler',
    command: 'javac',
    knownPaths: ['/usr/bin/javac', ...brewPaths('javac')],
    probeArgs: ['-version'],
    requireSuccessfulProbe: true,
    guidance: guidance('A full JDK is required to compile Java projects.', 'brew install --cask temurin', 'https://adoptium.net/temurin/releases/')
  },
  {
    id: 'clang',
    name: 'Clang C Compiler',
    command: 'clang',
    knownPaths: ['/usr/bin/clang', ...brewPaths('clang')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('C development tools were not found. Install Xcode Command Line Tools.', 'xcode-select --install')
  },
  {
    id: 'clang++',
    name: 'Clang C++ Compiler',
    command: 'clang++',
    knownPaths: ['/usr/bin/clang++', ...brewPaths('clang++')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('C++ development tools were not found. Install Xcode Command Line Tools.', 'xcode-select --install')
  },
  {
    id: 'swift',
    name: 'Swift',
    command: 'swift',
    knownPaths: ['/usr/bin/swift'],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('The Apple Swift toolchain was not found. Install Xcode or Xcode Command Line Tools.', 'xcode-select --install', 'https://developer.apple.com/xcode/')
  },
  {
    id: 'swiftc',
    name: 'Swift Compiler',
    command: 'swiftc',
    knownPaths: ['/usr/bin/swiftc'],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('The Swift compiler was not found. Install Xcode or Xcode Command Line Tools.', 'xcode-select --install', 'https://developer.apple.com/xcode/')
  },
  {
    id: 'dotnet',
    name: '.NET SDK',
    command: 'dotnet',
    knownPaths: ['/usr/local/share/dotnet/dotnet', ...brewPaths('dotnet')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('The .NET SDK is required to build and run C# projects.', 'brew install --cask dotnet-sdk', 'https://dotnet.microsoft.com/en-us/download')
  },
  {
    id: 'rustc',
    name: 'Rust Compiler',
    command: 'rustc',
    knownPaths: brewPaths('rustc'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Rust is required to compile Rust projects.', 'brew install rust', 'https://www.rust-lang.org/tools/install')
  },
  {
    id: 'cargo',
    name: 'Cargo',
    command: 'cargo',
    knownPaths: brewPaths('cargo'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Cargo is required for Cargo-based Rust projects.', 'brew install rust', 'https://www.rust-lang.org/tools/install')
  },
  {
    id: 'go',
    name: 'Go',
    command: 'go',
    knownPaths: brewPaths('go'),
    probeArgs: ['version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Go is required to build and run Go projects.', 'brew install go', 'https://go.dev/doc/install')
  },
  {
    id: 'ruby',
    name: 'Ruby',
    command: 'ruby',
    knownPaths: ['/usr/bin/ruby', ...brewPaths('ruby')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Ruby is required to run Ruby projects.', 'brew install ruby', 'https://www.ruby-lang.org/en/documentation/installation/')
  },
  {
    id: 'php',
    name: 'PHP',
    command: 'php',
    knownPaths: brewPaths('php'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('PHP is required to run PHP projects.', 'brew install php', 'https://www.php.net/manual/en/install.macosx.php')
  },
  {
    id: 'lua',
    name: 'Lua',
    command: 'lua',
    knownPaths: brewPaths('lua'),
    probeArgs: ['-v'],
    requireSuccessfulProbe: true,
    guidance: guidance('Lua is required to run Lua scripts.', 'brew install lua', 'https://www.lua.org/download.html')
  },
  {
    id: 'kotlinc',
    name: 'Kotlin Compiler',
    command: 'kotlinc',
    knownPaths: brewPaths('kotlinc'),
    probeArgs: ['-version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Kotlin is required to compile Kotlin projects.', 'brew install kotlin', 'https://kotlinlang.org/docs/command-line.html')
  },
  {
    id: 'gradle',
    name: 'Gradle',
    command: 'gradle',
    knownPaths: brewPaths('gradle'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Gradle is optional when a project includes its own Gradle wrapper.', 'brew install gradle', 'https://gradle.org/install/')
  },
  {
    id: 'make',
    name: 'Make',
    command: 'make',
    knownPaths: ['/usr/bin/make', ...brewPaths('make')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Make is included with Xcode Command Line Tools.', 'xcode-select --install')
  },
  {
    id: 'docker',
    name: 'Docker',
    command: 'docker',
    knownPaths: ['/usr/local/bin/docker', ...brewPaths('docker'), '/Applications/Docker.app/Contents/Resources/bin/docker'],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Docker is optional and is only required by container-based projects.', 'brew install --cask docker', 'https://docs.docker.com/desktop/setup/install/mac-install/')
  },
  {
    id: 'ollama',
    name: 'Ollama',
    command: 'ollama',
    knownPaths: [
      '/usr/local/bin/ollama',
      ...brewPaths('ollama'),
      '/Applications/Ollama.app/Contents/Resources/ollama',
      path.join(homedir(), 'Applications/Ollama.app/Contents/Resources/ollama')
    ],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Ollama is required only for local AI models; cloud AI and editor features remain available.', 'brew install ollama', 'https://ollama.com/download/mac')
  },
  {
    id: 'bash',
    name: 'Bash',
    command: 'bash',
    knownPaths: ['/bin/bash', ...brewPaths('bash')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Bash is optional because OmniCode uses zsh by default.', 'brew install bash')
  },
  {
    id: 'zsh',
    name: 'zsh',
    command: 'zsh',
    knownPaths: ['/bin/zsh', ...brewPaths('zsh')],
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('zsh is OmniCode’s default macOS terminal shell.', 'brew install zsh')
  },
  {
    id: 'fish',
    name: 'Fish',
    command: 'fish',
    knownPaths: brewPaths('fish'),
    probeArgs: ['--version'],
    requireSuccessfulProbe: true,
    guidance: guidance('Fish is optional and only needed when selected as a terminal shell.', 'brew install fish', 'https://fishshell.com/')
  }
] as const

/** Execute a binary directly. Arguments are never concatenated or interpreted by a shell. */
export const runExecutable: SafeCommandRunner = async (
  executable,
  args = [],
  options = {}
) =>
  new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const processError = error as (Error & {
          code?: string | number
          signal?: NodeJS.Signals
        }) | null

        resolve({
          ok: error === null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode:
            error === null ? 0 : typeof processError?.code === 'number' ? processError.code : null,
          errorCode:
            error !== null && typeof processError?.code === 'string'
              ? processError.code
              : undefined,
          signal: processError?.signal
        })
      }
    )
  })

const defaultExecutableAccessCheck: ExecutableAccessCheck = async (path) => {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function firstOutputLine(result: CommandExecutionResult): string | undefined {
  const output = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)

  return output?.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

function formatGuidance(value: InstallationGuidance): string {
  const parts = [value.message]
  if (value.command) parts.push(`Install: ${value.command}`)
  if (value.url) parts.push(`More information: ${value.url}`)
  return parts.join(' ')
}

function diagnosticFor(result: CommandExecutionResult): string | undefined {
  return firstOutputLine(result) ??
    (result.errorCode ? `Unable to execute the tool (${result.errorCode}).` : undefined)
}

export class RuntimeManager {
  readonly #runner: SafeCommandRunner
  readonly #isExecutable: ExecutableAccessCheck
  readonly #env: NodeJS.ProcessEnv
  readonly #platform: NodeJS.Platform
  readonly #timeoutMs: number

  constructor(options: RuntimeManagerOptions = {}) {
    this.#runner = options.runner ?? runExecutable
    this.#isExecutable = options.isExecutable ?? defaultExecutableAccessCheck
    this.#env = options.env ?? process.env
    this.#platform = options.platform ?? process.platform
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async #appleDeveloperToolsAvailable(): Promise<boolean> {
    // Unlike git/clang/etc., this query does not request installation. Check
    // the directory too: xcode-select can print a stale DEVELOPER_DIR value.
    const selected = await this.#runner('/usr/bin/xcode-select', ['-p'], {
      env: this.#env,
      timeoutMs: this.#timeoutMs
    })
    const directory = selected.stdout.trim()
    return selected.ok && path.isAbsolute(directory) && await this.#isExecutable(directory)
  }

  async detect(toolId: RuntimeToolId): Promise<RuntimeToolInfo> {
    const definition = RUNTIME_TOOL_DEFINITIONS.find(({ id }) => id === toolId)
    if (!definition) {
      // The union and definition table should make this unreachable at runtime.
      throw new TypeError(`Unknown runtime tool: ${toolId as string}`)
    }

    const candidates = unique([definition.command, ...(definition.aliases ?? [])])
    const detectedPaths: string[] = []

    for (const knownPath of definition.knownPaths ?? []) {
      if (await this.#isExecutable(knownPath)) detectedPaths.push(knownPath)
    }

    const locator = this.#platform === 'win32' ? 'where' : '/usr/bin/which'
    const locatorArgsPrefix = this.#platform === 'win32' ? [] : ['-a']
    for (const candidate of candidates) {
      const located = await this.#runner(locator, [...locatorArgsPrefix, candidate], {
        env: this.#env,
        timeoutMs: this.#timeoutMs
      })
      if (located.ok) {
        detectedPaths.push(
          ...located.stdout
            .split(/\r?\n/u)
            .map((path) => path.trim())
            .filter(Boolean)
        )
      }
    }

    const locations = unique(detectedPaths)
    let executable: string | undefined
    let probe: CommandExecutionResult | undefined
    const skipAppleShims = this.#platform === 'darwin' &&
      APPLE_DEVELOPER_SHIM_TOOLS.has(toolId) &&
      !await this.#appleDeveloperToolsAvailable()

    // Apple shims and stale version-manager links can precede a working tool.
    // Try every discovered location before falling back to PATH resolution.
    for (const location of unique([...locations, ...candidates])) {
      // which -a already resolved PATH alternatives above. Do not retry a bare
      // command here: it could resolve straight back to the skipped shim.
      if (skipAppleShims && (!path.isAbsolute(location) || path.dirname(location) === '/usr/bin')) continue
      const candidateProbe = await this.#runner(location, definition.probeArgs, {
        env: this.#env,
        timeoutMs: this.#timeoutMs
      })
      if (candidateProbe.ok || (!definition.requireSuccessfulProbe && locations.includes(location))) {
        executable = location
        probe = candidateProbe
        break
      }
      probe ??= candidateProbe
    }

    const installed = Boolean(executable) &&
      (!definition.requireSuccessfulProbe || probe?.ok === true)
    const firstLine = probe ? firstOutputLine(probe) : undefined

    return {
      id: definition.id,
      name: definition.name,
      command: definition.command,
      installed,
      path: installed ? executable : undefined,
      detectedPaths: locations,
      version:
        installed && !definition.probeOutputIsDetail ? firstLine : undefined,
      details:
        installed && definition.probeOutputIsDetail ? firstLine : undefined,
      diagnostic: !installed && probe ? diagnosticFor(probe) : undefined,
      guidance: installed ? undefined : formatGuidance(definition.guidance),
      installation: installed ? undefined : definition.guidance,
      // Full Xcode uses the App Store; the optional python alias is not a
      // separate runtime package. All other tools have an allowlisted plan.
      installable: !installed && definition.id !== 'xcode' && definition.id !== 'python'
    }
  }

  async detectAll(
    toolIds: readonly RuntimeToolId[] = RUNTIME_TOOL_DEFINITIONS.map(({ id }) => id)
  ): Promise<RuntimeToolInfo[]> {
    return Promise.all(toolIds.map((toolId) => this.detect(toolId)))
  }
}

export async function detectRuntimeTool(
  toolId: RuntimeToolId,
  options: RuntimeManagerOptions = {}
): Promise<RuntimeToolInfo> {
  const env = options.env ?? await resolveShellEnvironment()
  return new RuntimeManager({ ...options, env }).detect(toolId)
}

export async function detectRuntimeTools(
  options: RuntimeManagerOptions = {},
  toolIds?: readonly RuntimeToolId[]
): Promise<RuntimeToolInfo[]> {
  const env = options.env ?? await resolveShellEnvironment()
  return new RuntimeManager({ ...options, env }).detectAll(toolIds)
}

/** Alias used by the main-process tools IPC implementation. */
export const detectTools = detectRuntimeTools

// Kept as a convenience export for the tools IPC boundary while the hardware
// implementation remains independently testable in hardware-manager.ts.
export { detectHardware } from './hardware-manager'
