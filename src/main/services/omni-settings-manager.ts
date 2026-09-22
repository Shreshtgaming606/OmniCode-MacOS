import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  OmniExecutionMode,
  OmniSettings,
  OmniVoiceActivation
} from '../../shared/omni-contracts'
import {
  createDefaultOmniSettings,
  OMNI_LIMITS
} from '../../shared/omni-contracts'
import type { AIProviderId } from '../../shared/contracts'
import type { WorkApprovalMode } from '../../shared/tool-contracts'

const PROVIDERS = new Set<AIProviderId>(['ollama', 'openai', 'anthropic', 'google'])
const EXECUTION_MODES = new Set<OmniExecutionMode>(['invisible', 'cursor'])
const APPROVAL_MODES = new Set<WorkApprovalMode>(['ask', 'auto', 'full'])
const VOICE_ACTIVATION_MODES = new Set<OmniVoiceActivation>(['off', 'shortcut-only', 'wake-word-and-shortcut'])
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]*$/u

export interface OmniSettingsUpdate {
  enabled?: boolean
  launchHelperAtLogin?: boolean
  menuBarItem?: boolean
  activation?: Partial<OmniSettings['activation']>
  voice?: Partial<OmniSettings['voice']>
  model?: Partial<OmniSettings['model']>
  executionMode?: OmniSettings['executionMode']
  approvalMode?: OmniSettings['approvalMode']
  fullAccessWarningAcknowledged?: boolean
  privacy?: Partial<OmniSettings['privacy']>
}

function clone(value: OmniSettings): OmniSettings {
  return {
    ...value,
    activation: { ...value.activation },
    voice: { ...value.voice },
    model: { ...value.model },
    privacy: { ...value.privacy }
  }
}

function validateBoundedText(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !SAFE_TEXT.test(value) || (!allowEmpty && !value.trim())) {
    throw new Error(`Omni ${field} is invalid.`)
  }
  return value
}

export function validateOmniSettings(value: unknown): OmniSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Omni settings are invalid.')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('Omni settings use an unsupported version.')
  if (typeof record.enabled !== 'boolean' || typeof record.launchHelperAtLogin !== 'boolean' ||
      typeof record.menuBarItem !== 'boolean' || typeof record.fullAccessWarningAcknowledged !== 'boolean') {
    throw new Error('Omni general settings are invalid.')
  }
  if (!record.activation || typeof record.activation !== 'object' || Array.isArray(record.activation)) {
    throw new Error('Omni activation settings are invalid.')
  }
  const activation = record.activation as Record<string, unknown>
  const shortcut = validateBoundedText(activation.shortcut, 'global shortcut', OMNI_LIMITS.shortcutCharacters)
  if (typeof activation.voiceActivation !== 'string' || !VOICE_ACTIVATION_MODES.has(activation.voiceActivation as OmniVoiceActivation)) {
    throw new Error('Omni voice activation setting is invalid.')
  }
  if (!record.voice || typeof record.voice !== 'object' || Array.isArray(record.voice)) throw new Error('Omni voice settings are invalid.')
  const voice = record.voice as Record<string, unknown>
  const voiceId = validateBoundedText(voice.voiceId, 'voice', OMNI_LIMITS.voiceIdCharacters, true)
  if (typeof voice.speakingRate !== 'number' || !Number.isFinite(voice.speakingRate) || voice.speakingRate < 0.5 || voice.speakingRate > 2) {
    throw new Error('Omni speaking rate is invalid.')
  }
  if (typeof voice.spokenResponses !== 'boolean') throw new Error('Omni spoken response setting is invalid.')
  if (!record.model || typeof record.model !== 'object' || Array.isArray(record.model)) throw new Error('Omni model settings are invalid.')
  const model = record.model as Record<string, unknown>
  if (typeof model.provider !== 'string' || !PROVIDERS.has(model.provider as AIProviderId)) throw new Error('Omni model provider is invalid.')
  const modelId = validateBoundedText(model.modelId, 'model', OMNI_LIMITS.modelCharacters, true)
  if (typeof record.executionMode !== 'string' || !EXECUTION_MODES.has(record.executionMode as OmniExecutionMode)) {
    throw new Error('Omni execution mode is invalid.')
  }
  if (typeof record.approvalMode !== 'string' || !APPROVAL_MODES.has(record.approvalMode as WorkApprovalMode)) {
    throw new Error('Omni approval mode is invalid.')
  }
  if (record.approvalMode === 'full' && record.fullAccessWarningAcknowledged !== true) {
    throw new Error('Omni Full approval mode requires an explicit warning acknowledgement.')
  }
  if (!record.privacy || typeof record.privacy !== 'object' || Array.isArray(record.privacy)) throw new Error('Omni privacy settings are invalid.')
  const privacy = record.privacy as Record<string, unknown>
  if (privacy.wakeWordProcessing !== 'on-device-only') throw new Error('Omni wake-word processing must remain on-device.')
  if (typeof privacy.screenObservationEnabled !== 'boolean') throw new Error('Omni screen observation setting is invalid.')
  if (!Number.isSafeInteger(privacy.activityRetentionDays) || (privacy.activityRetentionDays as number) < 0 ||
      (privacy.activityRetentionDays as number) > OMNI_LIMITS.activityRetentionDays) {
    throw new Error('Omni activity retention is invalid.')
  }
  return {
    version: 1,
    enabled: record.enabled,
    launchHelperAtLogin: record.launchHelperAtLogin,
    menuBarItem: record.menuBarItem,
    activation: {
      shortcut,
      voiceActivation: activation.voiceActivation as OmniVoiceActivation
    },
    voice: {
      voiceId,
      speakingRate: voice.speakingRate,
      spokenResponses: voice.spokenResponses
    },
    model: {
      provider: model.provider as AIProviderId,
      modelId
    },
    executionMode: record.executionMode as OmniExecutionMode,
    approvalMode: record.approvalMode as WorkApprovalMode,
    fullAccessWarningAcknowledged: record.fullAccessWarningAcknowledged,
    privacy: {
      wakeWordProcessing: 'on-device-only',
      screenObservationEnabled: privacy.screenObservationEnabled,
      activityRetentionDays: privacy.activityRetentionDays as number
    }
  }
}

export class OmniSettingsManager {
  #operation: Promise<void> = Promise.resolve()

  constructor(private readonly storePath: string) {}

  async get(): Promise<OmniSettings> {
    await this.#operation
    return this.#read()
  }

  async set(settings: OmniSettings): Promise<OmniSettings> {
    const validated = validateOmniSettings(settings)
    return this.#update(() => validated)
  }

  async update(changes: OmniSettingsUpdate): Promise<OmniSettings> {
    return this.#update((current) => ({
      ...current,
      ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
      ...(changes.launchHelperAtLogin !== undefined ? { launchHelperAtLogin: changes.launchHelperAtLogin } : {}),
      ...(changes.menuBarItem !== undefined ? { menuBarItem: changes.menuBarItem } : {}),
      ...(changes.activation ? { activation: { ...current.activation, ...changes.activation } } : {}),
      ...(changes.voice ? { voice: { ...current.voice, ...changes.voice } } : {}),
      ...(changes.model ? { model: { ...current.model, ...changes.model } } : {}),
      ...(changes.executionMode !== undefined ? { executionMode: changes.executionMode } : {}),
      ...(changes.approvalMode !== undefined ? { approvalMode: changes.approvalMode } : {}),
      ...(changes.fullAccessWarningAcknowledged !== undefined
        ? { fullAccessWarningAcknowledged: changes.fullAccessWarningAcknowledged }
        : {}),
      ...(changes.privacy ? { privacy: { ...current.privacy, ...changes.privacy } } : {})
    }))
  }

  async #update(change: (current: OmniSettings) => OmniSettings): Promise<OmniSettings> {
    let result = createDefaultOmniSettings()
    const task = this.#operation.then(async () => {
      result = validateOmniSettings(change(await this.#read()))
      await this.#write(result)
    })
    this.#operation = task.catch(() => undefined)
    await task
    return clone(result)
  }

  async #read(): Promise<OmniSettings> {
    try {
      const stat = await fs.stat(this.storePath)
      if (!stat.isFile() || stat.size > OMNI_LIMITS.settingsStoreBytes) return createDefaultOmniSettings()
      return clone(validateOmniSettings(JSON.parse(await fs.readFile(this.storePath, 'utf8'))))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError ||
          (error instanceof Error && /^Omni\b/u.test(error.message))) {
        // Missing, corrupt, unsupported, or unsafe state always migrates to private defaults.
        return createDefaultOmniSettings()
      }
      throw error
    }
  }

  async #write(settings: OmniSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporaryPath, this.storePath)
      await fs.chmod(this.storePath, 0o600)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}
