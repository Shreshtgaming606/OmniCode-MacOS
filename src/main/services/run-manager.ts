import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PackageScript, RunConfiguration } from '../../shared/contracts'
import {
  readBoundedTextFile,
  safeMetadataOutput,
  workspaceMetadataFile,
  workspaceRootFile,
  workspaceWorkingDirectory
} from './workspace-metadata'

const MAX_RUN_CONFIGURATION_BYTES = 256 * 1024
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function hasFile(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export class RunManager {
  async resolve(filePath: string, workspacePath: string): Promise<RunConfiguration> {
    const extension = path.extname(filePath).toLowerCase()
    const basename = path.basename(filePath, extension)
    const cwd = await workspaceWorkingDirectory(workspacePath || path.dirname(filePath))
    const custom = await this.readCustomConfiguration(cwd)
    if (custom) return custom
    const toolchains = await this.readToolchains(cwd)
    const tool = (id: string, fallback = id): string => toolchains[id] ?? fallback
    const required = (id: string): string | undefined => toolchains[id] ? undefined : id

    if (await hasFile(path.join(cwd, 'Cargo.toml'))) {
      return { name: 'Cargo Run', command: tool('cargo'), args: ['run'], cwd, requiredTool: required('cargo'), missingTool: 'Cargo was not found. Install Rust from rustup.rs or with `brew install rust`.', description: 'Rust project detected from Cargo.toml' }
    }
    if (await hasFile(path.join(cwd, 'go.mod'))) {
      return { name: 'Go Run', command: tool('go'), args: ['run', '.'], cwd, requiredTool: required('go'), missingTool: 'Go was not found. Install it from go.dev or with `brew install go`.', description: 'Go module detected from go.mod' }
    }
    if (await hasFile(path.join(cwd, 'Package.swift'))) {
      return { name: 'Swift Package Run', command: tool('swift'), args: ['run'], cwd, requiredTool: required('swift'), missingTool: 'Swift was not found. Install Xcode Command Line Tools with `xcode-select --install`.', description: 'Swift package detected from Package.swift' }
    }
    const gradleWrapper = path.join(cwd, 'gradlew')
    if (await hasFile(gradleWrapper) || await hasFile(path.join(cwd, 'build.gradle')) || await hasFile(path.join(cwd, 'build.gradle.kts'))) {
      const wrapper = await hasFile(gradleWrapper)
      return { name: 'Gradle Run', command: wrapper ? gradleWrapper : tool('gradle'), args: ['run'], cwd, requiredTool: wrapper ? undefined : required('gradle'), missingTool: 'Gradle was not found. Use a Gradle wrapper or install Gradle with `brew install gradle`.', description: 'Gradle project detected' }
    }

    const direct: Record<string, { name: string; command: string; args: string[]; requiredTool: string; missingTool: string }> = {
      '.py': { name: 'Run Python', command: 'python3', args: [filePath], requiredTool: 'python3', missingTool: 'Python 3 was not found. Install it from python.org or with `brew install python`.' },
      '.js': { name: 'Run JavaScript', command: 'node', args: [filePath], requiredTool: 'node', missingTool: 'Node.js was not found. Install it from nodejs.org or with `brew install node`.' },
      '.mjs': { name: 'Run JavaScript', command: 'node', args: [filePath], requiredTool: 'node', missingTool: 'Node.js was not found. Install it from nodejs.org or with `brew install node`.' },
      '.cjs': { name: 'Run JavaScript', command: 'node', args: [filePath], requiredTool: 'node', missingTool: 'Node.js was not found. Install it from nodejs.org or with `brew install node`.' },
      '.ts': { name: 'Run TypeScript', command: 'npx', args: ['--no-install', 'tsx', filePath], requiredTool: 'npm', missingTool: 'TypeScript execution requires Node.js and a project-local tsx package. Add it with `npm install --save-dev tsx`.' },
      '.mts': { name: 'Run TypeScript', command: 'npx', args: ['--no-install', 'tsx', filePath], requiredTool: 'npm', missingTool: 'TypeScript execution requires Node.js and a project-local tsx package. Add it with `npm install --save-dev tsx`.' },
      '.cts': { name: 'Run TypeScript', command: 'npx', args: ['--no-install', 'tsx', filePath], requiredTool: 'npm', missingTool: 'TypeScript execution requires Node.js and a project-local tsx package. Add it with `npm install --save-dev tsx`.' },
      '.rb': { name: 'Run Ruby', command: 'ruby', args: [filePath], requiredTool: 'ruby', missingTool: 'Ruby was not found. Install a Ruby runtime before running this file.' },
      '.php': { name: 'Run PHP', command: 'php', args: [filePath], requiredTool: 'php', missingTool: 'PHP was not found. Install it with `brew install php`.' },
      '.swift': { name: 'Run Swift', command: 'swift', args: [filePath], requiredTool: 'swift', missingTool: 'Swift was not found. Install Xcode Command Line Tools with `xcode-select --install`.' },
      '.go': { name: 'Run Go', command: 'go', args: ['run', filePath], requiredTool: 'go', missingTool: 'Go was not found. Install it from go.dev or with `brew install go`.' },
      '.lua': { name: 'Run Lua', command: 'lua', args: [filePath], requiredTool: 'lua', missingTool: 'Lua was not found. Install it with `brew install lua`.' },
      '.sh': { name: 'Run Shell Script', command: '/bin/zsh', args: [filePath], requiredTool: 'zsh', missingTool: 'zsh is required to run this shell script.' },
      '.bash': { name: 'Run Bash Script', command: '/bin/bash', args: [filePath], requiredTool: 'bash', missingTool: 'Bash was not found.' },
      '.zsh': { name: 'Run zsh Script', command: '/bin/zsh', args: [filePath], requiredTool: 'zsh', missingTool: 'zsh was not found.' },
      '.fish': { name: 'Run Fish Script', command: 'fish', args: [filePath], requiredTool: 'fish', missingTool: 'Fish was not found. Install it with `brew install fish`.' },
      '.kts': { name: 'Run Kotlin Script', command: 'kotlinc', args: ['-script', filePath], requiredTool: 'kotlinc', missingTool: 'Kotlin was not found. Install it with `brew install kotlin`.' }
    }
    if (direct[extension]) {
      const configuration = direct[extension]
      const configuredCommand = toolchains[configuration.command] ??
        (configuration.command === configuration.requiredTool ? toolchains[configuration.requiredTool] : undefined)
      return {
        ...configuration,
        command: configuredCommand ?? configuration.command,
        requiredTool: configuredCommand ? undefined : configuration.requiredTool,
        cwd
      }
    }

    if (extension === '.c' || ['.cc', '.cpp', '.cxx', '.m', '.mm'].includes(extension)) {
      const compilerId = extension === '.c' || extension === '.m' ? 'clang' : 'clang++'
      const compiler = tool(compilerId)
      const output = await safeMetadataOutput(cwd, basename)
      const command = `${shellQuote(compiler)} ${shellQuote(filePath)} -o ${shellQuote(output)} && ${shellQuote(output)}`
      return {
        name: `Build & Run ${compilerId === 'clang' ? 'C' : 'C++'}`,
        command: '/bin/zsh',
        args: ['-lc', command],
        cwd,
        requiredTool: required(compilerId),
        missingTool: 'Apple Clang was not found. Install Xcode Command Line Tools with `xcode-select --install`.'
      }
    }

    if (extension === '.java') {
      const command = `${shellQuote(tool('javac'))} ${shellQuote(filePath)} && ${shellQuote(tool('java'))} -cp ${shellQuote(path.dirname(filePath))} ${shellQuote(basename)}`
      return {
        name: 'Build & Run Java', command: '/bin/zsh', args: ['-lc', command], cwd,
        requiredTool: required('javac'),
        missingTool: 'A JDK with javac was not found. Install a JDK before running Java files.'
      }
    }

    if (extension === '.cs') {
      return {
        name: 'Run .NET project', command: tool('dotnet'), args: ['run'], cwd,
        requiredTool: required('dotnet'),
        missingTool: '.NET SDK was not found. Install it from dotnet.microsoft.com.'
      }
    }

    if (extension === '.rs') {
      const output = await safeMetadataOutput(cwd, basename)
      const command = `${shellQuote(tool('rustc'))} ${shellQuote(filePath)} -o ${shellQuote(output)} && ${shellQuote(output)}`
      return { name: 'Build & Run Rust', command: '/bin/zsh', args: ['-lc', command], cwd, requiredTool: required('rustc'), missingTool: 'Rust was not found. Install it from rustup.rs or with `brew install rust`.' }
    }

    if (extension === '.kt') {
      const output = await safeMetadataOutput(cwd, `${basename}.jar`)
      const command = `${shellQuote(tool('kotlinc'))} ${shellQuote(filePath)} -include-runtime -d ${shellQuote(output)} && ${shellQuote(tool('java'))} -jar ${shellQuote(output)}`
      return { name: 'Build & Run Kotlin', command: '/bin/zsh', args: ['-lc', command], cwd, requiredTool: required('kotlinc'), missingTool: 'Kotlin was not found. Install it with `brew install kotlin`.' }
    }

    if (/^(?:GNUmakefile|BSDmakefile|Makefile)$/i.test(path.basename(filePath)) || ['.mk', '.mak', '.make'].includes(extension)) {
      return { name: 'Run Make', command: tool('make'), args: [], cwd, requiredTool: required('make'), missingTool: 'Make was not found. Install Xcode Command Line Tools with `xcode-select --install`.' }
    }

    if (/^(?:Dockerfile|Containerfile)(?:\..+)?$/i.test(path.basename(filePath)) || extension === '.dockerfile') {
      return { name: 'Build Docker Image', command: tool('docker'), args: ['build', '--file', filePath, '.'], cwd, requiredTool: required('docker'), missingTool: 'Docker was not found. Install and start Docker Desktop before building this image.' }
    }

    throw new Error(`OmniCode does not have an automatic run configuration for ${extension || 'this file type'}. Add runCommand to omnicode.json.`)
  }

  async packageScripts(workspacePath: string): Promise<PackageScript[]> {
    try {
      const packagePath = await workspaceRootFile(workspacePath, 'package.json')
      if (!packagePath) return []
      const packageJson = JSON.parse(await readBoundedTextFile(packagePath, MAX_PACKAGE_MANIFEST_BYTES, 'package.json')) as { scripts?: Record<string, string> }
      const runner = await workspaceRootFile(workspacePath, 'pnpm-lock.yaml') ? 'pnpm'
        : await workspaceRootFile(workspacePath, 'yarn.lock') ? 'yarn'
          : await workspaceRootFile(workspacePath, 'bun.lockb') || await workspaceRootFile(workspacePath, 'bun.lock') ? 'bun'
            : 'npm'
      return Object.keys(packageJson.scripts ?? {}).map((name) => ({ name, command: `${runner} run ${shellQuote(name)}` }))
    } catch {
      return []
    }
  }

  private async readCustomConfiguration(cwd: string): Promise<RunConfiguration | null> {
    try {
      const raw = await readBoundedTextFile(await workspaceMetadataFile(cwd, 'settings.json'), MAX_RUN_CONFIGURATION_BYTES, '.omnicode/settings.json')
      const settings = JSON.parse(raw) as {
        run?: {
          command?: string; buildCommand?: string; workingDirectory?: string; args?: string[]
          environment?: Record<string, string>; preRunCommand?: string; postRunCommand?: string
        }
      }
      const config = settings.run
      if (config?.command?.trim()) {
        const commandWithArguments = [shellQuote(config.command), ...(config.args ?? []).map(shellQuote)].join(' ')
        const pipeline = [config.preRunCommand, config.buildCommand, commandWithArguments, config.postRunCommand].filter((command): command is string => Boolean(command?.trim())).join(' && ')
        const customCwd = await workspaceWorkingDirectory(cwd, config.workingDirectory)
        return {
          name: 'Workspace Run Configuration', command: '/bin/zsh', args: ['-lc', pipeline],
          cwd: customCwd, env: config.environment,
          description: 'Loaded from .omnicode/settings.json'
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw new Error(`.omnicode/settings.json is not valid JSON: ${error.message}`)
        throw error
      }
    }
    try {
      const configPath = await workspaceRootFile(cwd, 'omnicode.json')
      if (!configPath) return null
      const raw = await readBoundedTextFile(configPath, MAX_RUN_CONFIGURATION_BYTES, 'omnicode.json')
      const config = JSON.parse(raw) as {
        runCommand?: string
        workingDirectory?: string
        environment?: Record<string, string>
      }
      if (!config.runCommand?.trim()) return null
      const customCwd = await workspaceWorkingDirectory(cwd, config.workingDirectory)
      return {
        name: 'Workspace Run Configuration',
        command: '/bin/zsh',
        args: ['-lc', config.runCommand],
        cwd: customCwd,
        env: config.environment,
        description: 'Loaded from omnicode.json'
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof SyntaxError) throw new Error(`omnicode.json is not valid JSON: ${error.message}`)
      throw error
    }
  }

  private async readToolchains(cwd: string): Promise<Record<string, string>> {
    try {
      const settings = JSON.parse(await readBoundedTextFile(await workspaceMetadataFile(cwd, 'settings.json'), MAX_RUN_CONFIGURATION_BYTES, '.omnicode/settings.json')) as { toolchains?: unknown }
      if (settings.toolchains === undefined) return {}
      if (!settings.toolchains || typeof settings.toolchains !== 'object' || Array.isArray(settings.toolchains)) throw new Error('toolchains must be an object in .omnicode/settings.json.')
      const result: Record<string, string> = {}
      for (const [name, executable] of Object.entries(settings.toolchains)) {
        if (!name.trim() || typeof executable !== 'string' || !executable.trim() || executable.length > 1_024 || /[\r\n\0]/u.test(executable)) throw new Error(`The custom toolchain entry “${name}” is invalid.`)
        result[name] = executable.trim()
      }
      return result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      if (error instanceof SyntaxError) throw new Error(`.omnicode/settings.json is not valid JSON: ${error.message}`)
      throw error
    }
  }
}

export const quoteTerminalArgument = shellQuote
