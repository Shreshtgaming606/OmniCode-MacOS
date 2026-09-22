import type { AIProviderId, ThemePreference } from '../../../shared/contracts'
import type { AppMode } from '../../../shared/work-contracts'

export type AgentPermission = 'ask' | 'workspace' | 'agent'

function storedEnum<T extends string>(
  storage: Pick<Storage, 'getItem'>,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = storage.getItem(key)
  return value !== null && allowed.includes(value as T) ? value as T : fallback
}

export function storedTheme(storage: Pick<Storage, 'getItem'>): ThemePreference {
  return storedEnum(storage, 'omnicode.theme', ['system', 'dark', 'light'], 'system')
}

export function storedAppMode(storage: Pick<Storage, 'getItem'>): AppMode {
  return storedEnum(storage, 'omnicode.appMode', ['code', 'work', 'omni'], 'code')
}

export function storedAgentPermission(storage: Pick<Storage, 'getItem'>): AgentPermission {
  return storedEnum(storage, 'omnicode.permission', ['ask', 'workspace', 'agent'], 'ask')
}

export function storedAIProvider(
  storage: Pick<Storage, 'getItem'>,
  key: string,
  fallback: AIProviderId
): AIProviderId {
  return storedEnum(storage, key, ['ollama', 'openai', 'anthropic', 'google'], fallback)
}

export function storedModelName(storage: Pick<Storage, 'getItem'>): string {
  const value = storage.getItem('omnicode.autocompleteModel')
  return value && value.length <= 256 && !/[\r\n\0]/u.test(value) ? value : ''
}
