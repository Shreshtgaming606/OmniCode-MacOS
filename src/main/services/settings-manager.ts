import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { WorkspaceSettings } from '../../shared/contracts'
import { readBoundedTextFile, workspaceMetadataFile } from './workspace-metadata'

const MAX_SETTINGS_BYTES = 256 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateOptionalString(value: unknown, label: string, maxLength = 16_384): void {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length > maxLength || /\0/u.test(value)) {
    throw new Error(`${label} must be a string no longer than ${maxLength.toLocaleString()} characters.`)
  }
}

function validateSettings(value: unknown): WorkspaceSettings {
  if (!isRecord(value)) throw new Error('Workspace settings must be a JSON object.')
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) throw new Error('Workspace settings are too large.')
  const settings = value as WorkspaceSettings
  for (const section of ['run', 'developmentServer', 'ai', 'editor'] as const) {
    if (settings[section] !== undefined && !isRecord(settings[section])) {
      throw new Error(`${section} must be a settings object.`)
    }
  }
  validateOptionalString(settings.run?.command, 'run.command')
  validateOptionalString(settings.run?.buildCommand, 'run.buildCommand')
  validateOptionalString(settings.run?.workingDirectory, 'run.workingDirectory', 4_096)
  validateOptionalString(settings.run?.preRunCommand, 'run.preRunCommand')
  validateOptionalString(settings.run?.postRunCommand, 'run.postRunCommand')
  if (settings.run?.args && !Array.isArray(settings.run.args)) throw new Error('run.args must be an array of strings.')
  if (settings.run?.args?.some((argument) => typeof argument !== 'string')) throw new Error('Every run argument must be a string.')
  if (settings.run?.environment && (typeof settings.run.environment !== 'object' || Array.isArray(settings.run.environment) || Object.values(settings.run.environment).some((item) => typeof item !== 'string'))) {
    throw new Error('run.environment must map variable names to string values.')
  }
  if (settings.run?.environment && Object.keys(settings.run.environment).some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
    throw new Error('run.environment contains an invalid environment variable name.')
  }
  validateOptionalString(settings.developmentServer?.script, 'developmentServer.script', 256)
  if (settings.developmentServer?.port !== undefined && (!Number.isInteger(settings.developmentServer.port) || settings.developmentServer.port < 1 || settings.developmentServer.port > 65_535)) {
    throw new Error('developmentServer.port must be between 1 and 65535.')
  }
  if (settings.editor?.tabSize !== undefined && (!Number.isInteger(settings.editor.tabSize) || settings.editor.tabSize < 1 || settings.editor.tabSize > 16)) {
    throw new Error('editor.tabSize must be between 1 and 16.')
  }
  if (settings.editor?.autosave !== undefined && typeof settings.editor.autosave !== 'boolean') {
    throw new Error('editor.autosave must be true or false.')
  }
  if (settings.ai?.provider !== undefined && !['ollama', 'openai', 'anthropic', 'google'].includes(settings.ai.provider)) {
    throw new Error('ai.provider must be ollama, openai, anthropic, or google.')
  }
  validateOptionalString(settings.ai?.chatModel, 'ai.chatModel', 256)
  validateOptionalString(settings.ai?.autocompleteModel, 'ai.autocompleteModel', 256)
  if (settings.ai?.exclusions && (!Array.isArray(settings.ai.exclusions) || settings.ai.exclusions.some((item) => typeof item !== 'string'))) {
    throw new Error('ai.exclusions must be an array of ignore-pattern strings.')
  }
  if (settings.languages && (typeof settings.languages !== 'object' || Array.isArray(settings.languages))) throw new Error('languages must be a settings object keyed by language ID.')
  for (const [language, languageSettings] of Object.entries(settings.languages ?? {})) {
    if (!language.trim() || !languageSettings || typeof languageSettings !== 'object' || Array.isArray(languageSettings)) throw new Error('Each language setting must be an object.')
    if (languageSettings.tabSize !== undefined && (!Number.isInteger(languageSettings.tabSize) || languageSettings.tabSize < 1 || languageSettings.tabSize > 16)) throw new Error(`languages.${language}.tabSize must be between 1 and 16.`)
    if (languageSettings.insertSpaces !== undefined && typeof languageSettings.insertSpaces !== 'boolean') throw new Error(`languages.${language}.insertSpaces must be true or false.`)
  }
  if (settings.toolchains && (typeof settings.toolchains !== 'object' || Array.isArray(settings.toolchains) || Object.entries(settings.toolchains).some(([name, executable]) => !name.trim() || typeof executable !== 'string' || !executable.trim() || executable.length > 1_024 || /[\r\n\0]/u.test(executable)))) {
    throw new Error('toolchains must map tool names to safe executable names or paths.')
  }
  if (settings.agentPermissions !== undefined && !['ask', 'workspace', 'agent'].includes(settings.agentPermissions)) {
    throw new Error('agentPermissions must be ask, workspace, or agent.')
  }
  return settings
}

export class SettingsManager {
  async read(root: string): Promise<WorkspaceSettings> {
    try {
      const raw = await readBoundedTextFile(await workspaceMetadataFile(root, 'settings.json'), MAX_SETTINGS_BYTES, 'Workspace settings')
      return validateSettings(JSON.parse(raw))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      if (error instanceof SyntaxError) throw new Error(`.omnicode/settings.json is not valid JSON: ${error.message}`)
      throw error
    }
  }

  async write(root: string, settings: WorkspaceSettings): Promise<void> {
    const validated = validateSettings(settings)
    const target = await workspaceMetadataFile(root, 'settings.json', true)
    const directory = path.dirname(target)
    const temporary = path.join(directory, `settings-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export { validateSettings }
