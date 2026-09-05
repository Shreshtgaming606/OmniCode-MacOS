import { describe, expect, it, vi } from 'vitest'

import {
  HardwareManager,
  type HardwareManagerOptions
} from './hardware-manager'
import type {
  CommandExecutionResult,
  SafeCommandRunner
} from './runtime-manager'

const success = (stdout: string): CommandExecutionResult => ({
  ok: true,
  stdout,
  stderr: '',
  exitCode: 0
})

const failure = (stderr = 'not available'): CommandExecutionResult => ({
  ok: false,
  stdout: '',
  stderr,
  exitCode: 1
})

function managerOptions(overrides: Partial<HardwareManagerOptions> = {}): HardwareManagerOptions {
  return {
    platform: 'darwin',
    architecture: 'arm64',
    osRelease: '23.6.0',
    cpus: Array.from({ length: 10 }, () => ({ model: 'Apple M3 Pro' })),
    totalMemoryBytes: 18 * 1024 ** 3,
    availableMemoryBytes: 9 * 1024 ** 3,
    ...overrides
  }
}

describe('HardwareManager', () => {
  it('reports Apple Silicon, memory, Metal, and Xcode details on macOS', async () => {
    const runner = vi.fn<SafeCommandRunner>(async (executable, args = []) => {
      const invocation = [executable, ...args].join(' ')
      switch (invocation) {
        case '/usr/bin/sw_vers -productVersion':
          return success('14.6.1\n')
        case '/usr/sbin/sysctl -n machdep.cpu.brand_string':
          return success('Apple M3 Pro\n')
        case '/usr/sbin/sysctl -n hw.model':
          return success('Mac15,6\n')
        case '/usr/sbin/sysctl -n hw.physicalcpu':
          return success('10\n')
        case '/usr/sbin/sysctl -n hw.logicalcpu':
          return success('10\n')
        case '/usr/sbin/system_profiler SPDisplaysDataType -json':
          return success(JSON.stringify({
            SPDisplaysDataType: [
              {
                _name: 'Apple M3 Pro',
                spdisplays_metal: 'spdisplays_supported'
              }
            ]
          }))
        case '/usr/bin/xcode-select -p':
          return success('/Applications/Xcode.app/Contents/Developer\n')
        case '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -version':
          return success('Xcode 15.4\nBuild version 15F31d\n')
        default:
          return failure(`Unexpected invocation: ${invocation}`)
      }
    })
    const manager = new HardwareManager(managerOptions({
      runner,
      isAccessible: async (path) => path.includes('Xcode.app')
    }))

    const hardware = await manager.detect()

    expect(hardware).toMatchObject({
      platform: 'darwin',
      architecture: 'arm64',
      appleSilicon: true,
      cpuModel: 'Apple M3 Pro',
      physicalCores: 10,
      logicalCores: 10,
      memoryBytes: 18 * 1024 ** 3,
      availableMemoryBytes: 9 * 1024 ** 3,
      unifiedMemory: true,
      metalSupported: true,
      gpu: 'Apple M3 Pro',
      macOSVersion: '14.6.1'
    })
    expect(hardware.xcode).toMatchObject({
      installed: true,
      version: '15.4',
      buildVersion: '15F31d',
      commandLineToolsInstalled: true
    })
    expect(hardware.warnings).toEqual([])
  })

  it('returns portable baseline information without running macOS commands elsewhere', async () => {
    const runner = vi.fn<SafeCommandRunner>(async () => {
      throw new Error('macOS commands must not run')
    })
    const manager = new HardwareManager(managerOptions({
      runner,
      platform: 'linux',
      architecture: 'x64',
      osRelease: '6.8.0',
      cpus: [{ model: 'Example CPU' }],
      totalMemoryBytes: 8 * 1024 ** 3,
      availableMemoryBytes: 3 * 1024 ** 3
    }))

    const hardware = await manager.detect()

    expect(runner).not.toHaveBeenCalled()
    expect(hardware).toMatchObject({
      platform: 'linux',
      architecture: 'x64',
      cpuModel: 'Example CPU',
      appleSilicon: false,
      unifiedMemory: false,
      metalSupported: false
    })
    expect(hardware.xcode.commandLineToolsInstalled).toBe(false)
    expect(hardware.warnings[0]).toContain('macOS-specific')
  })

  it('degrades to Node hardware data when macOS probes fail', async () => {
    const manager = new HardwareManager(managerOptions({
      runner: async () => {
        throw new Error('probe failed')
      },
      isAccessible: async () => false
    }))

    await expect(manager.detect()).resolves.toMatchObject({
      cpuModel: 'Apple M3 Pro',
      logicalCores: 10,
      appleSilicon: true,
      metalSupported: false,
      xcode: {
        installed: false,
        commandLineToolsInstalled: false
      }
    })
  })
})
