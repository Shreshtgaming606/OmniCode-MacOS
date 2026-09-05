import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsManager, validateSettings } from './settings-manager'

describe('workspace settings validation', () => {
  it('accepts a scoped run configuration', () => {
    expect(validateSettings({ run: { command: 'npm', args: ['test', '--watch'] } }).run?.command).toBe('npm')
  })

  it('rejects invalid ports and argument shapes', () => {
    expect(() => validateSettings({ developmentServer: { port: 70_000 } })).toThrow(/65535/)
    expect(() => validateSettings({ run: { args: 'unsafe' } })).toThrow(/array/)
    expect(() => validateSettings({ editor: { tabSize: 0 } })).toThrow(/tabSize/)
    expect(() => validateSettings({ languages: { python: { insertSpaces: 'yes' } } })).toThrow(/true or false/)
    expect(() => validateSettings({ toolchains: { python3: 'bad\ncommand' } })).toThrow(/safe executable/)
    expect(() => validateSettings({ ai: { provider: 'unknown' } })).toThrow(/ai\.provider/)
    expect(() => validateSettings({ editor: 'autosave' })).toThrow(/editor must be/)
    expect(() => validateSettings({ run: { environment: { 'BAD-NAME': 'value' } } })).toThrow(/environment variable/)
    expect(() => validateSettings({ agentPermissions: 'unrestricted' })).toThrow(/agentPermissions/)
  })

  it('rejects workspace metadata symlinks that leave the workspace', async () => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-settings-'))
    try {
      const root = path.join(container, 'workspace')
      const outside = path.join(container, 'outside')
      await fs.mkdir(root)
      await fs.mkdir(outside)
      await fs.writeFile(path.join(outside, 'settings.json'), '{"editor":{"autosave":false}}')
      await fs.symlink(outside, path.join(root, '.omnicode'))
      const manager = new SettingsManager()

      await expect(manager.read(root)).rejects.toThrow(/symbolic link/i)
      await expect(manager.write(root, { editor: { autosave: true } })).rejects.toThrow(/symbolic link/i)
      expect(await fs.readFile(path.join(outside, 'settings.json'), 'utf8')).toContain('false')
    } finally {
      await fs.rm(container, { recursive: true, force: true })
    }
  })

  it('rejects an oversized settings file before parsing it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-settings-'))
    try {
      await fs.mkdir(path.join(root, '.omnicode'))
      await fs.writeFile(path.join(root, '.omnicode', 'settings.json'), ' '.repeat(256 * 1024 + 1))
      await expect(new SettingsManager().read(root)).rejects.toThrow(/too large/i)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
