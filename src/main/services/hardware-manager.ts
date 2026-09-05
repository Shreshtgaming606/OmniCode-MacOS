import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  arch as hostArchitecture,
  cpus as hostCpus,
  freemem,
  platform as hostPlatform,
  release as hostRelease,
  totalmem
} from 'node:os'

import type { HardwareInfo } from '../../shared/contracts'
import {
  runExecutable,
  type CommandExecutionResult,
  type SafeCommandRunner
} from './runtime-manager'

const GIBIBYTE = 1024 ** 3
const HARDWARE_COMMAND_TIMEOUT_MS = 8_000

export interface MetalInfo {
  supported: boolean
  devices: string[]
  details?: string
  diagnostic?: string
}

export interface XcodeInfo {
  installed: boolean
  version?: string
  buildVersion?: string
  commandLineToolsInstalled: boolean
  developerDirectory?: string
  diagnostic?: string
}

export interface DetailedHardwareInfo extends HardwareInfo {
  osRelease: string
  physicalCores?: number
  unifiedMemory: boolean
  memoryGiB: number
  availableMemoryGiB: number
  gpus: string[]
  metal: MetalInfo
  xcode: XcodeInfo
  warnings: string[]
}

export type AccessiblePathCheck = (path: string) => Promise<boolean>

export interface CpuDescriptor {
  model: string
}

export interface HardwareManagerOptions {
  runner?: SafeCommandRunner
  isAccessible?: AccessiblePathCheck
  platform?: NodeJS.Platform
  architecture?: string
  osRelease?: string
  cpus?: readonly CpuDescriptor[]
  totalMemoryBytes?: number
  availableMemoryBytes?: number
}

const defaultAccessiblePathCheck: AccessiblePathCheck = async (path) => {
  try {
    await access(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

function firstOutputLine(result: CommandExecutionResult): string | undefined {
  return `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function xcodeVersion(output: string): Pick<XcodeInfo, 'version' | 'buildVersion'> {
  const version = output.match(/^Xcode\s+(.+)$/mu)?.[1]?.trim()
  const buildVersion = output.match(/^Build version\s+(.+)$/mu)?.[1]?.trim()
  return { version, buildVersion }
}

function profileEntries(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  const root = value as Record<string, unknown>
  const displays = root.SPDisplaysDataType
  if (!Array.isArray(displays)) return []

  const entries: Record<string, unknown>[] = []
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    entries.push(record)
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit)
    }
  }
  displays.forEach(visit)
  return entries
}

function metalSupportValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  if (/not[ _-]?supported|unsupported/iu.test(value)) return false
  if (/supported|metal\s+[0-9]/iu.test(value)) return true
  return undefined
}

function parseMetalProfile(output: string): MetalInfo | undefined {
  try {
    const entries = profileEntries(JSON.parse(output) as unknown)
    if (entries.length === 0) return undefined

    const devices: string[] = []
    const details: string[] = []
    let supported: boolean | undefined

    for (const entry of entries) {
      const device = [entry.sppci_model, entry.spdisplays_product_name, entry._name]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      if (device) devices.push(device)

      for (const [key, value] of Object.entries(entry)) {
        if (!key.toLowerCase().includes('metal')) continue
        const parsedSupport = metalSupportValue(value)
        if (parsedSupport === true) supported = true
        else if (parsedSupport === false && supported === undefined) supported = false
        if (typeof value === 'string' && value.trim()) details.push(value.trim())
      }
    }

    return {
      supported: supported ?? false,
      devices: unique(devices),
      details: unique(details).join('; ') || undefined
    }
  } catch {
    return undefined
  }
}

export class HardwareManager {
  readonly #runner: SafeCommandRunner
  readonly #isAccessible: AccessiblePathCheck
  readonly #platform: NodeJS.Platform
  readonly #architecture: string
  readonly #osRelease: string
  readonly #cpus: readonly CpuDescriptor[]
  readonly #totalMemoryBytes: number
  readonly #availableMemoryBytes: number

  constructor(options: HardwareManagerOptions = {}) {
    this.#runner = options.runner ?? runExecutable
    this.#isAccessible = options.isAccessible ?? defaultAccessiblePathCheck
    this.#platform = options.platform ?? hostPlatform()
    this.#architecture = options.architecture ?? hostArchitecture()
    this.#osRelease = options.osRelease ?? hostRelease()
    this.#cpus = options.cpus ?? hostCpus()
    this.#totalMemoryBytes = options.totalMemoryBytes ?? totalmem()
    this.#availableMemoryBytes = options.availableMemoryBytes ?? freemem()
  }

  async #run(executable: string, args: readonly string[]): Promise<CommandExecutionResult> {
    try {
      return await this.#runner(executable, args, {
        timeoutMs: HARDWARE_COMMAND_TIMEOUT_MS
      })
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : 'Hardware query failed.',
        exitCode: null
      }
    }
  }

  async #sysctl(name: string): Promise<string | undefined> {
    const result = await this.#run('/usr/sbin/sysctl', ['-n', name])
    return result.ok ? firstOutputLine(result) : undefined
  }

  async #detectMetal(): Promise<MetalInfo> {
    if (this.#platform !== 'darwin') {
      return {
        supported: false,
        devices: [],
        diagnostic: 'Metal is available only on macOS.'
      }
    }

    const profile = await this.#run('/usr/sbin/system_profiler', [
      'SPDisplaysDataType',
      '-json'
    ])
    if (profile.ok) {
      const parsed = parseMetalProfile(profile.stdout)
      if (parsed) return parsed
    }

    const frameworkPath = '/System/Library/Frameworks/Metal.framework/Metal'
    if (await this.#isAccessible(frameworkPath)) {
      return {
        supported: true,
        devices: [],
        details: 'Metal framework is installed.',
        diagnostic: profile.ok
          ? 'Metal was detected, but GPU details were unavailable.'
          : firstOutputLine(profile)
      }
    }

    return {
      supported: false,
      devices: [],
      diagnostic: firstOutputLine(profile) ?? 'Unable to determine Metal support.'
    }
  }

  async #detectXcode(): Promise<XcodeInfo> {
    if (this.#platform !== 'darwin') {
      return {
        installed: false,
        commandLineToolsInstalled: false,
        diagnostic: 'Xcode detection is available only on macOS.'
      }
    }

    const selected = await this.#run('/usr/bin/xcode-select', ['-p'])
    const developerDirectory = selected.ok ? firstOutputLine(selected) : undefined
    const commandLineToolsInstalled = Boolean(developerDirectory)

    const candidates = unique([
      ...(developerDirectory ? [join(developerDirectory, 'usr/bin/xcodebuild')] : []),
      '/usr/bin/xcodebuild',
      '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild',
      '/Applications/Xcode-beta.app/Contents/Developer/usr/bin/xcodebuild'
    ])

    let lastFailure: CommandExecutionResult | undefined
    for (const candidate of candidates) {
      if (candidate !== '/usr/bin/xcodebuild' && !(await this.#isAccessible(candidate))) {
        continue
      }
      const result = await this.#run(candidate, ['-version'])
      if (result.ok && /^Xcode\s+/mu.test(result.stdout)) {
        const parsed = xcodeVersion(result.stdout)
        return {
          installed: true,
          commandLineToolsInstalled,
          developerDirectory,
          ...parsed
        }
      }
      lastFailure = result
    }

    return {
      installed: false,
      commandLineToolsInstalled,
      developerDirectory,
      diagnostic:
        firstOutputLine(lastFailure ?? selected) ??
        'Full Xcode was not found; Xcode Command Line Tools may still be available.'
    }
  }

  async detect(): Promise<DetailedHardwareInfo> {
    const fallbackCpuModel = this.#cpus.find(({ model }) => model.trim())?.model.trim() ||
      'Unknown CPU'
    const logicalCoreFallback = this.#cpus.length

    if (this.#platform !== 'darwin') {
      const metal = await this.#detectMetal()
      const xcode = await this.#detectXcode()
      return {
        platform: this.#platform,
        architecture: this.#architecture,
        appleSilicon: false,
        cpuModel: fallbackCpuModel,
        logicalCores: logicalCoreFallback,
        memoryBytes: this.#totalMemoryBytes,
        availableMemoryBytes: this.#availableMemoryBytes,
        metalSupported: false,
        osRelease: this.#osRelease,
        unifiedMemory: false,
        memoryGiB: this.#totalMemoryBytes / GIBIBYTE,
        availableMemoryGiB: this.#availableMemoryBytes / GIBIBYTE,
        gpus: [],
        metal,
        xcode,
        warnings: [
          'macOS-specific Metal and Xcode details are unavailable on this platform.'
        ]
      }
    }

    const [
      macOSVersionResult,
      cpuBrand,
      hardwareModel,
      physicalCoreOutput,
      logicalCoreOutput,
      metal,
      xcode
    ] = await Promise.all([
      this.#run('/usr/bin/sw_vers', ['-productVersion']),
      this.#sysctl('machdep.cpu.brand_string'),
      this.#sysctl('hw.model'),
      this.#sysctl('hw.physicalcpu'),
      this.#sysctl('hw.logicalcpu'),
      this.#detectMetal(),
      this.#detectXcode()
    ])

    const cpuModel = cpuBrand ||
      (fallbackCpuModel !== 'Unknown CPU' ? fallbackCpuModel : hardwareModel) ||
      'Unknown CPU'
    const physicalCores = positiveInteger(physicalCoreOutput ?? '')
    const logicalCores = positiveInteger(logicalCoreOutput ?? '') ?? logicalCoreFallback
    const appleSilicon = this.#architecture === 'arm64'
    const warnings: string[] = []
    if (!metal.supported) warnings.push(metal.diagnostic ?? 'Metal support was not detected.')
    if (!xcode.commandLineToolsInstalled) {
      warnings.push('Xcode Command Line Tools were not detected. Run: xcode-select --install')
    }

    return {
      platform: this.#platform,
      architecture: this.#architecture,
      appleSilicon,
      cpuModel,
      logicalCores,
      physicalCores,
      memoryBytes: this.#totalMemoryBytes,
      availableMemoryBytes: this.#availableMemoryBytes,
      metalSupported: metal.supported,
      gpu: metal.devices[0],
      macOSVersion: macOSVersionResult.ok
        ? firstOutputLine(macOSVersionResult)
        : undefined,
      osRelease: this.#osRelease,
      unifiedMemory: appleSilicon,
      memoryGiB: this.#totalMemoryBytes / GIBIBYTE,
      availableMemoryGiB: this.#availableMemoryBytes / GIBIBYTE,
      gpus: metal.devices,
      metal,
      xcode,
      warnings
    }
  }
}

export async function detectHardware(
  options: HardwareManagerOptions = {}
): Promise<DetailedHardwareInfo> {
  return new HardwareManager(options).detect()
}

/** Alias used by the main-process tools IPC implementation. */
export const detectHardwareInfo = detectHardware
