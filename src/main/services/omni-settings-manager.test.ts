import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createDefaultOmniSettings, OMNI_LIMITS, type OmniSettings } from '../../shared/omni-contracts'
import { OmniSettingsManager, validateOmniSettings } from './omni-settings-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function manager(): Promise<{ value: OmniSettingsManager; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-omni-settings-'))
  roots.push(root)
  const file = path.join(root, 'private', 'settings.json')
  return { value: new OmniSettingsManager(file), file }
}

describe('Omni settings defaults and validation', () => {
  it('starts disabled with conservative private defaults and returns independent values', async () => {
    const { value } = await manager()
    const expected = createDefaultOmniSettings()

    expect(expected).toEqual({
      version: 1,
      enabled: false,
      setupCompleted: false,
      showTextInput: false,
      launchHelperAtLogin: false,
      menuBarItem: false,
      activation: { shortcut: 'CommandOrControl+Shift+Space', voiceActivation: 'shortcut-only' },
      voice: { voiceId: '', speakingRate: 1, spokenResponses: true },
      model: { provider: 'ollama', modelId: '' },
      executionMode: 'invisible',
      approvalMode: 'ask',
      fullAccessWarningAcknowledged: false,
      privacy: {
        wakeWordProcessing: 'on-device-only',
        screenObservationEnabled: false,
        activityRetentionDays: 30
      }
    })

    const first = await value.get()
    first.activation.shortcut = 'mutated'
    expect(await value.get()).toEqual(expected)
  })

  it('normalizes a valid document to the supported schema and strips unknown data', () => {
    const input = {
      ...createDefaultOmniSettings(),
      enabled: true,
      activation: { shortcut: 'Command+Shift+Space', voiceActivation: 'wake-word-and-shortcut' },
      voice: { voiceId: 'com.apple.voice.compact.en-US.Samantha', speakingRate: 1.25, spokenResponses: false },
      model: { provider: 'google', modelId: 'gemini-test' },
      executionMode: 'cursor',
      approvalMode: 'auto',
      privacy: { wakeWordProcessing: 'on-device-only', screenObservationEnabled: true, activityRetentionDays: 7 },
      apiKey: 'must-never-survive'
    }

    const validated = validateOmniSettings(input)
    expect(validated).toMatchObject({ enabled: true, executionMode: 'cursor', approvalMode: 'auto' })
    expect(validated.activation.voiceActivation).toBe('shortcut-only')
    expect(validated.privacy.screenObservationEnabled).toBe(false)
    expect(validated).not.toHaveProperty('apiKey')
    expect(validated).not.toBe(input)
    expect(validated.activation).not.toBe(input.activation)
  })

  it.each([
    ['unsupported version', { version: 2 }],
    ['non-boolean enablement', { enabled: 'yes' }],
    ['empty shortcut', { activation: { shortcut: '   ' } }],
    ['control characters in shortcut', { activation: { shortcut: 'Command+\nSpace' } }],
    ['oversized shortcut', { activation: { shortcut: 'x'.repeat(OMNI_LIMITS.shortcutCharacters + 1) } }],
    ['emergency stop shortcut collision', { activation: { shortcut: 'CommandOrControl+Shift+Escape' } }],
    ['unknown voice activation', { activation: { voiceActivation: 'always-listening' } }],
    ['unsafe speaking rate', { voice: { speakingRate: 2.01 } }],
    ['non-finite speaking rate', { voice: { speakingRate: Number.NaN } }],
    ['unknown provider', { model: { provider: 'other' } }],
    ['oversized model ID', { model: { modelId: 'm'.repeat(OMNI_LIMITS.modelCharacters + 1) } }],
    ['unknown execution mode', { executionMode: 'hidden' }],
    ['unknown approval mode', { approvalMode: 'never' }],
    ['unacknowledged Full approval mode', { approvalMode: 'full' }],
    ['cloud wake word processing', { privacy: { wakeWordProcessing: 'cloud' } }],
    ['negative retention', { privacy: { activityRetentionDays: -1 } }],
    ['excessive retention', { privacy: { activityRetentionDays: OMNI_LIMITS.activityRetentionDays + 1 } }]
  ])('rejects %s', (_label, replacement) => {
    const base = createDefaultOmniSettings()
    const candidate = {
      ...base,
      ...replacement,
      activation: { ...base.activation, ...('activation' in replacement ? replacement.activation : {}) },
      voice: { ...base.voice, ...('voice' in replacement ? replacement.voice : {}) },
      model: { ...base.model, ...('model' in replacement ? replacement.model : {}) },
      privacy: { ...base.privacy, ...('privacy' in replacement ? replacement.privacy : {}) }
    }
    expect(() => validateOmniSettings(candidate)).toThrow(/Omni/i)
  })
})

describe('OmniSettingsManager persistence', () => {
  it('atomically writes a mode-0600 file and serializes concurrent partial updates without lost fields', async () => {
    const { value, file } = await manager()

    await Promise.all([
      value.update({ enabled: true }),
      value.update({ setupCompleted: true, showTextInput: true }),
      value.update({ launchHelperAtLogin: true, menuBarItem: true }),
      value.update({ activation: { shortcut: 'CommandOrControl+Option+Space' } }),
      value.update({ voice: { voiceId: 'voice.test', speakingRate: 1.5 } }),
      value.update({ model: { provider: 'anthropic', modelId: 'claude-test' } }),
      value.update({ executionMode: 'cursor', approvalMode: 'auto' }),
      value.update({ privacy: { activityRetentionDays: 14 } })
    ])

    expect(await value.get()).toMatchObject({
      enabled: true,
      setupCompleted: true,
      showTextInput: true,
      launchHelperAtLogin: true,
      menuBarItem: true,
      activation: { shortcut: 'CommandOrControl+Option+Space' },
      voice: { voiceId: 'voice.test', speakingRate: 1.5 },
      model: { provider: 'anthropic', modelId: 'claude-test' },
      executionMode: 'cursor',
      approvalMode: 'auto',
      privacy: { screenObservationEnabled: false, activityRetentionDays: 14 }
    })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(path.dirname(file))).toEqual(['settings.json'])
    expect(validateOmniSettings(JSON.parse(await fs.readFile(file, 'utf8')))).toEqual(await value.get())
  })

  it('migrates existing version-1 settings to voice-first interface defaults', () => {
    const current = createDefaultOmniSettings()
    const legacy = { ...current } as Partial<OmniSettings>
    delete legacy.setupCompleted
    delete legacy.showTextInput

    expect(validateOmniSettings(legacy)).toMatchObject({ setupCompleted: false, showTextInput: false })
  })

  it('does not persist invalid updates and keeps the operation queue usable after a rejection', async () => {
    const { value, file } = await manager()
    await value.update({ enabled: true })
    const before = await fs.readFile(file, 'utf8')

    await expect(value.update({ voice: { speakingRate: Number.POSITIVE_INFINITY } })).rejects.toThrow(/speaking rate/i)
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    await expect(value.update({ menuBarItem: true })).resolves.toMatchObject({ enabled: true, menuBarItem: true })
  })

  it('requires and persists an explicit one-time warning acknowledgement before Full approval mode', async () => {
    const { value, file } = await manager()
    await expect(value.update({ approvalMode: 'full' })).rejects.toThrow(/explicit warning acknowledgement/i)
    await expect(value.get()).resolves.toMatchObject({ approvalMode: 'ask', fullAccessWarningAcknowledged: false })

    await expect(value.update({
      approvalMode: 'full',
      fullAccessWarningAcknowledged: true
    })).resolves.toMatchObject({ approvalMode: 'full', fullAccessWarningAcknowledged: true })

    const restarted = new OmniSettingsManager(file)
    await expect(restarted.get()).resolves.toMatchObject({ approvalMode: 'full', fullAccessWarningAcknowledged: true })
    await restarted.update({ approvalMode: 'ask' })
    await expect(restarted.update({ approvalMode: 'full' })).resolves.toMatchObject({ approvalMode: 'full' })
    await expect(restarted.update({ fullAccessWarningAcknowledged: false })).rejects.toThrow(/explicit warning acknowledgement/i)
  })

  it('fails closed to disabled defaults for missing, corrupt, unsupported, oversized, and non-file state', async () => {
    const { value, file } = await manager()
    const expected = createDefaultOmniSettings()
    await expect(value.get()).resolves.toEqual(expected)

    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{broken')
    await expect(value.get()).resolves.toEqual(expected)

    await fs.writeFile(file, JSON.stringify({ ...expected, version: 99 }))
    await expect(value.get()).resolves.toEqual(expected)

    await fs.writeFile(file, 'x'.repeat(OMNI_LIMITS.settingsStoreBytes + 1))
    await expect(value.get()).resolves.toEqual(expected)

    await fs.rm(file)
    await fs.mkdir(file)
    await expect(value.get()).resolves.toEqual(expected)
  })

  it('set snapshots validated data and excludes unknown secret-bearing properties', async () => {
    const { value, file } = await manager()
    const candidate = {
      ...createDefaultOmniSettings(),
      enabled: true,
      credential: 'settings-secret'
    } as OmniSettings & { credential: string }

    const result = await value.set(candidate)
    candidate.activation.shortcut = 'changed-after-set'
    result.model.modelId = 'changed-result'

    const raw = await fs.readFile(file, 'utf8')
    expect(raw).not.toContain('settings-secret')
    expect(await value.get()).toEqual({ ...createDefaultOmniSettings(), enabled: true })
  })
})
