import { spawn } from 'node:child_process'
import path from 'node:path'
import { access } from 'node:fs/promises'
import { shell, systemPreferences } from 'electron'

import { isPathInside } from './filesystem-manager'

const APPLICATIONS: Record<string, { name: string; bundle: string }> = {
  safari: { name: 'Safari', bundle: 'Safari' },
  chrome: { name: 'Google Chrome', bundle: 'Google Chrome' },
  finder: { name: 'Finder', bundle: 'Finder' },
  terminal: { name: 'Terminal', bundle: 'Terminal' },
  simulator: { name: 'Simulator', bundle: 'Simulator' },
  xcode: { name: 'Xcode', bundle: 'Xcode' },
  preview: { name: 'Preview', bundle: 'Preview' },
  textedit: { name: 'TextEdit', bundle: 'TextEdit' }
}

export interface CodeApplicationPermissions {
  accessibility: 'granted' | 'not-granted' | 'unavailable'
  screenRecording: 'granted' | 'not-granted' | 'unavailable'
  structuredComputerControl: 'not-implemented'
}

interface CodeApplicationDependencies {
  runOpen(args: string[]): Promise<void>
  openExternal(target: string): Promise<unknown>
  accessibilityTrusted(): boolean
  screenRecordingStatus(): string
}

const DEFAULT_DEPENDENCIES: CodeApplicationDependencies = {
  runOpen,
  openExternal: (target) => shell.openExternal(target),
  accessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
  screenRecordingStatus: () => systemPreferences.getMediaAccessStatus('screen')
}

function runOpen(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`macOS could not launch the requested application (exit ${code ?? 'unknown'}).`)))
  })
}

export class CodeApplicationManager {
  constructor(private readonly dependencies: CodeApplicationDependencies = DEFAULT_DEPENDENCIES) {}

  list(): Array<{ id: string; name: string }> {
    return Object.entries(APPLICATIONS).map(([id, application]) => ({ id, name: application.name }))
  }

  permissions(): CodeApplicationPermissions {
    if (process.platform !== 'darwin') return { accessibility: 'unavailable', screenRecording: 'unavailable', structuredComputerControl: 'not-implemented' }
    let accessibility: CodeApplicationPermissions['accessibility'] = 'not-granted'
    let screenRecording: CodeApplicationPermissions['screenRecording'] = 'not-granted'
    try { accessibility = this.dependencies.accessibilityTrusted() ? 'granted' : 'not-granted' } catch { accessibility = 'unavailable' }
    try { screenRecording = this.dependencies.screenRecordingStatus() === 'granted' ? 'granted' : 'not-granted' } catch { screenRecording = 'unavailable' }
    return { accessibility, screenRecording, structuredComputerControl: 'not-implemented' }
  }

  async launch(applicationId: string, workspaceRoot: string, relativeTarget?: string, background = false): Promise<{ application: string; target?: string }> {
    const application = APPLICATIONS[applicationId]
    if (!application) throw new Error('Choose an allowlisted development application.')
    let target: string | undefined
    if (relativeTarget) {
      if (path.isAbsolute(relativeTarget) || relativeTarget.split(/[\\/]/u).includes('..') || /[\0\r\n]/u.test(relativeTarget)) throw new Error('Application targets must stay inside the workspace.')
      target = path.resolve(workspaceRoot, relativeTarget)
      if (!isPathInside(workspaceRoot, target)) throw new Error('Application targets must stay inside the workspace.')
      await access(target)
    }
    await this.dependencies.runOpen([...(background ? ['-g'] : []), '-a', application.bundle, ...(target ? [target] : [])])
    return { application: application.name, ...(relativeTarget ? { target: relativeTarget } : {}) }
  }

  async openPermissionSettings(kind: 'accessibility' | 'screen-recording'): Promise<void> {
    const target = kind === 'accessibility'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    await this.dependencies.openExternal(target)
  }
}
