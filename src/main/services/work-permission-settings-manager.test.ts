import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkPermissionSettingsManager } from './work-permission-settings-manager'

const temporaryDirectories: string[] = []

async function manager(): Promise<{ manager: WorkPermissionSettingsManager; file: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-work-permissions-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, 'settings.json')
  return { manager: new WorkPermissionSettingsManager(file), file }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('WorkPermissionSettingsManager', () => {
  it('migrates missing and corrupt state to Ask for approval', async () => {
    const { manager: settings, file } = await manager()
    await expect(settings.get()).resolves.toMatchObject({ globalMode: 'ask', connectorOverrides: {} })
    await fs.writeFile(file, '{broken')
    await expect(settings.get()).resolves.toMatchObject({ globalMode: 'ask', connectorOverrides: {} })
  })

  it('persists global mode and connector overrides in a private application store', async () => {
    const { manager: settings, file } = await manager()
    await settings.setGlobal('auto')
    await settings.setConnector('gmail', 'ask')
    const restarted = new WorkPermissionSettingsManager(file)
    await expect(restarted.get()).resolves.toMatchObject({
      globalMode: 'auto', connectorOverrides: { gmail: 'ask' }
    })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    await restarted.setConnector('gmail', null)
    await expect(restarted.get()).resolves.toMatchObject({ connectorOverrides: {} })
  })

  it('requires a one-time explicit acknowledgement before any Full Access selection', async () => {
    const { manager: settings, file } = await manager()
    await expect(settings.setGlobal('full')).rejects.toThrow(/Full Access warning/i)
    await expect(settings.setConnector('browser', 'full')).rejects.toThrow(/Full Access warning/i)
    await settings.setConnector('browser', 'full', true)
    await expect(new WorkPermissionSettingsManager(file).setGlobal('full')).resolves.toMatchObject({
      globalMode: 'full', fullAccessWarningAcknowledged: true
    })
  })

  it('resolves connector overrides without allowing invalid modes or IDs', async () => {
    const { manager: settings } = await manager()
    const stored = await settings.setGlobal('auto')
    expect(settings.effectiveMode(stored, 'gmail')).toBe('auto')
    const overridden = await settings.setConnector('gmail', 'ask')
    expect(settings.effectiveMode(overridden, 'gmail')).toBe('ask')
    await expect(settings.setConnector('../outside', 'full', true)).rejects.toThrow(/invalid connector ID/i)
    await expect(settings.setGlobal('unrestricted' as 'full', true)).rejects.toThrow(/Choose Ask/i)
  })
})
