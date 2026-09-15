import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodeApplicationManager } from './code-application-manager'

const roots: string[] = []

function dependencies() {
  return {
    runOpen: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    accessibilityTrusted: vi.fn(() => true),
    screenRecordingStatus: vi.fn(() => 'granted')
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CodeApplicationManager', () => {
  it('launches only allowlisted applications and uses background focus without a shell', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omnicode-app-manager-'))
    roots.push(root)
    await writeFile(path.join(root, 'demo.txt'), 'demo\n')
    const runtime = dependencies()
    const manager = new CodeApplicationManager(runtime)

    await expect(manager.launch('textedit', root, 'demo.txt', true)).resolves.toEqual({ application: 'TextEdit', target: 'demo.txt' })
    expect(runtime.runOpen).toHaveBeenCalledWith(['-g', '-a', 'TextEdit', path.join(root, 'demo.txt')])
    await expect(manager.launch('untrusted-app', root)).rejects.toThrow(/allowlisted/i)
    await expect(manager.launch('textedit', root, '../outside.txt')).rejects.toThrow(/inside the workspace/i)
    expect(runtime.runOpen).toHaveBeenCalledTimes(1)
  })

  it('reports native permission state honestly and opens only exact privacy panes', async () => {
    const runtime = dependencies()
    const manager = new CodeApplicationManager(runtime)

    expect(manager.permissions()).toEqual({
      accessibility: process.platform === 'darwin' ? 'granted' : 'unavailable',
      screenRecording: process.platform === 'darwin' ? 'granted' : 'unavailable',
      structuredComputerControl: 'not-implemented'
    })
    await manager.openPermissionSettings('accessibility')
    await manager.openPermissionSettings('screen-recording')
    expect(runtime.openExternal).toHaveBeenNthCalledWith(1, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    expect(runtime.openExternal).toHaveBeenNthCalledWith(2, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
})
