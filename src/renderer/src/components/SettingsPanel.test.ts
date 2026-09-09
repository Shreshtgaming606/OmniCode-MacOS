import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SettingsPanel } from './SettingsPanel'

describe('SettingsPanel Work and model settings', () => {
  it('uses a cloud model selector and exposes the real Connected Apps section', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, {
      workspacePath: null,
      theme: 'system',
      autosave: false,
      permission: 'ask',
      aiAutocomplete: false,
      autocompleteProvider: 'google',
      autocompleteModel: '',
      onTheme: () => undefined,
      onAutosave: () => undefined,
      onPermission: () => undefined,
      onAIAutocomplete: () => undefined,
      onAutocompleteProvider: () => undefined,
      onAutocompleteModel: () => undefined,
      onWorkspaceSettings: () => undefined,
      onClose: () => undefined
    }))

    expect(html).toContain('aria-label="Google Gemini autocomplete model"')
    expect(html).toContain('Refresh google autocomplete models')
    expect(html).not.toContain('Provider model ID')
    expect(html).toContain('href="#connected-apps"')
    expect(html).toContain('Work Mode · Connected Apps')
    expect(html).toContain('This build will not display simulated connected services.')
  })
})
