import { describe, expect, it } from 'vitest'

import {
  storedAppMode,
  storedAgentPermission,
  storedAIProvider,
  storedModelName,
  storedTheme
} from './preferences'

function storage(values: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (key) => values[key] ?? null }
}

describe('stored renderer preferences', () => {
  it('returns supported values', () => {
    const values = storage({
      'omnicode.theme': 'light',
      'omnicode.appMode': 'work',
      'omnicode.permission': 'agent',
      'omnicode.provider': 'google',
      'omnicode.autocompleteModel': 'gemini-3.5-flash'
    })
    expect(storedTheme(values)).toBe('light')
    expect(storedAppMode(values)).toBe('work')
    expect(storedAgentPermission(values)).toBe('agent')
    expect(storedAIProvider(values, 'omnicode.provider', 'ollama')).toBe('google')
    expect(storedModelName(values)).toBe('gemini-3.5-flash')
  })

  it('falls back for absent, corrupt, multiline, and oversized values', () => {
    expect(storedTheme(storage({ 'omnicode.theme': 'sepia' }))).toBe('system')
    expect(storedAppMode(storage({ 'omnicode.appMode': 'future' }))).toBe('code')
    expect(storedAppMode(storage({}))).toBe('code')
    expect(storedAgentPermission(storage({ 'omnicode.permission': 'unrestricted' }))).toBe('ask')
    expect(storedAIProvider(storage({ 'omnicode.provider': 'unknown' }), 'omnicode.provider', 'ollama')).toBe('ollama')
    expect(storedModelName(storage({ 'omnicode.autocompleteModel': 'bad\nmodel' }))).toBe('')
    expect(storedModelName(storage({ 'omnicode.autocompleteModel': 'x'.repeat(257) }))).toBe('')
  })
})
