import { useEffect, useState } from 'react'
import { CheckCircle2, KeyRound, LoaderCircle, Shield, Trash2, X } from 'lucide-react'
import type { AIModel, AIProviderId, ThemePreference, WorkspaceSettings } from '../../../shared/contracts'

type CloudProvider = Exclude<AIProviderId, 'ollama'>
const PROVIDERS: Array<{ id: CloudProvider; name: string; placeholder: string }> = [
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'anthropic', name: 'Anthropic Claude', placeholder: 'sk-ant-…' },
  { id: 'google', name: 'Google Gemini', placeholder: 'API key' }
]

export function SettingsPanel({
  workspacePath,
  theme,
  autosave,
  permission,
  aiAutocomplete,
  autocompleteProvider,
  autocompleteModel,
  onTheme,
  onAutosave,
  onPermission,
  onAIAutocomplete,
  onAutocompleteProvider,
  onAutocompleteModel,
  onWorkspaceSettings,
  onClose
}: {
  workspacePath: string | null
  theme: ThemePreference
  autosave: boolean
  permission: 'ask' | 'workspace' | 'agent'
  aiAutocomplete: boolean
  autocompleteProvider: AIProviderId
  autocompleteModel: string
  onTheme(value: ThemePreference): void
  onAutosave(value: boolean): void
  onPermission(value: 'ask' | 'workspace' | 'agent'): void
  onAIAutocomplete(value: boolean): void
  onAutocompleteProvider(value: AIProviderId): void
  onAutocompleteModel(value: string): void
  onWorkspaceSettings(value: WorkspaceSettings): void
  onClose(): void
}) {
  const [keys, setKeys] = useState<Record<CloudProvider, string>>({ openai: '', anthropic: '', google: '' })
  const [stored, setStored] = useState<Record<CloudProvider, boolean | null>>({ openai: null, anthropic: null, google: null })
  const [credentialBusy, setCredentialBusy] = useState<Partial<Record<CloudProvider, 'saving' | 'removing'>>>({})
  const [credentialErrors, setCredentialErrors] = useState<Partial<Record<CloudProvider, string>>>({})
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [workspaceJson, setWorkspaceJson] = useState('{}')
  const [localModels, setLocalModels] = useState<AIModel[]>([])
  useEffect(() => {
    let active = true
    for (const { id } of PROVIDERS) {
      void window.omnicode.ai.hasCredential(id)
        .then((value) => { if (active) setStored((current) => ({ ...current, [id]: value })) })
        .catch((cause) => { if (active) setCredentialErrors((current) => ({ ...current, [id]: cause instanceof Error ? cause.message : String(cause) })) })
    }
    return () => { active = false }
  }, [])
  useEffect(() => {
    void window.omnicode.ai.models().then((models) => {
      setLocalModels(models.filter((model) => model.installed !== false))
      if (autocompleteProvider === 'ollama' && !autocompleteModel && models[0]) onAutocompleteModel(models[0].id)
    }).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!workspacePath) return setWorkspaceJson('{}')
    void window.omnicode.settings.read(workspacePath).then((settings) => setWorkspaceJson(JSON.stringify(settings, null, 2))).catch((cause) => { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) })
  }, [workspacePath])
  const saveKey = async (provider: CloudProvider): Promise<void> => {
    if (credentialBusy[provider]) return
    setCredentialBusy((current) => ({ ...current, [provider]: 'saving' }))
    setCredentialErrors((current) => ({ ...current, [provider]: undefined }))
    setStatus('')
    try {
      await window.omnicode.ai.setCredential(provider, keys[provider])
      setStored((current) => ({ ...current, [provider]: true }))
      setKeys((current) => ({ ...current, [provider]: '' }))
      setStatusError(false)
      setStatus(`${PROVIDERS.find((item) => item.id === provider)!.name} API key saved and verified in macOS Keychain.`)
    } catch (cause) {
      setStored((current) => ({ ...current, [provider]: null }))
      setCredentialErrors((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) }))
    } finally { setCredentialBusy((current) => ({ ...current, [provider]: undefined })) }
  }
  const deleteKey = async (provider: CloudProvider): Promise<void> => {
    if (credentialBusy[provider]) return
    setCredentialBusy((current) => ({ ...current, [provider]: 'removing' }))
    setCredentialErrors((current) => ({ ...current, [provider]: undefined }))
    setStatus('')
    try {
      await window.omnicode.ai.deleteCredential(provider)
      setStored((current) => ({ ...current, [provider]: false }))
      setStatusError(false)
      setStatus(`${PROVIDERS.find((item) => item.id === provider)!.name} API key removed.`)
    } catch (cause) {
      setCredentialErrors((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) }))
    } finally { setCredentialBusy((current) => ({ ...current, [provider]: undefined })) }
  }
  return <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
    <div className="settings-panel">
      <header><div><h1>Settings</h1><p>User settings · stored locally</p></div><button onClick={onClose} title="Close settings"><X /></button></header>
      <div className="settings-content">
        <nav><a href="#appearance">Appearance</a><a href="#files">Files & Autosave</a><a href="#providers">AI Providers</a><a href="#autocomplete">AI Autocomplete</a><a href="#workspace">Workspace</a><a href="#permissions">Permissions & Privacy</a></nav>
        <main>
          <section id="appearance"><h2>Appearance</h2><p>Choose how OmniCode follows macOS.</p>
            <div className="segmented">{(['system', 'dark', 'light'] as ThemePreference[]).map((item) => <button className={theme === item ? 'active' : ''} key={item} onClick={() => onTheme(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
          </section>
          <section id="files"><h2>Files & Autosave</h2><label className="setting-toggle"><span><strong>Autosave</strong><small>Save changed files after a short delay.</small></span><input type="checkbox" checked={autosave} onChange={(event) => onAutosave(event.target.checked)} /></label></section>
          <section id="providers"><h2>AI Providers</h2><p>Credentials are written to macOS Keychain and never to a workspace or log.</p>
            {PROVIDERS.map((provider) => <div className="provider-setting" key={provider.id} aria-busy={!!credentialBusy[provider.id]}>
              <div><KeyRound /><span><strong>{provider.name}</strong><small>{credentialBusy[provider.id] ? <><LoaderCircle className="spin" />{credentialBusy[provider.id] === 'saving' ? 'Saving and verifying…' : 'Removing…'}</> : credentialErrors[provider.id] ? 'Keychain needs attention' : stored[provider.id] === null ? 'Checking Keychain…' : stored[provider.id] ? <><CheckCircle2 /> Credential stored</> : 'Not configured'}</small></span></div>
              <input aria-label={`${provider.name} API key`} type="password" autoComplete="off" disabled={!!credentialBusy[provider.id]} value={keys[provider.id]} placeholder={stored[provider.id] ? 'Replace saved credential' : provider.placeholder} onChange={(event) => setKeys((current) => ({ ...current, [provider.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && keys[provider.id].trim()) void saveKey(provider.id) }} />
              <button aria-label={`Save ${provider.name} API key`} disabled={!keys[provider.id].trim() || !!credentialBusy[provider.id]} onClick={() => void saveKey(provider.id)}>{credentialBusy[provider.id] === 'saving' ? 'Saving…' : 'Save'}</button>
              {stored[provider.id] && <button className="icon-button danger" title={`Delete ${provider.name} credential`} disabled={!!credentialBusy[provider.id]} onClick={() => void deleteKey(provider.id)}><Trash2 /></button>}
              {credentialErrors[provider.id] && <p className="provider-error" role="alert">{credentialErrors[provider.id]}</p>}
            </div>)}
            {status && <div className={`settings-status${statusError ? ' error' : ''}`} role={statusError ? 'alert' : 'status'}>{status}</div>}
          </section>
          <section id="autocomplete"><h2>AI Autocomplete</h2><p>Use a separate model for editor suggestions. This is disabled by default; cloud providers receive the nearby code shown to the completion model.</p>
            <label className="setting-toggle"><span><strong>Inline AI suggestions</strong><small>Generate next-line suggestions while you type. Press Tab to accept a suggestion.</small></span><input type="checkbox" checked={aiAutocomplete} onChange={(event) => {
              const enabled = event.target.checked
              if (enabled && autocompleteProvider !== 'ollama' && !window.confirm(`Enable cloud autocomplete with ${autocompleteProvider}? Nearby code will be sent to the provider while you type.`)) return
              onAIAutocomplete(enabled)
            }} /></label>
            <div className="provider-setting autocomplete-setting">
              <label><strong>Provider</strong><select value={autocompleteProvider} onChange={(event) => {
                const next = event.target.value as AIProviderId
                if (aiAutocomplete && next !== 'ollama' && !window.confirm(`Switch autocomplete to ${next}? Nearby code will be sent to this cloud provider while you type.`)) return
                onAutocompleteProvider(next)
                onAutocompleteModel(next === 'ollama' ? localModels[0]?.id ?? '' : '')
              }}><option value="ollama">Ollama · local</option><option value="openai">OpenAI · cloud</option><option value="anthropic">Anthropic · cloud</option><option value="google">Google Gemini · cloud</option></select></label>
              <label><strong>Model</strong>{autocompleteProvider === 'ollama'
                ? <select value={autocompleteModel} onChange={(event) => onAutocompleteModel(event.target.value)}><option value="">Choose an installed model</option>{localModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
                : <input value={autocompleteModel} onChange={(event) => onAutocompleteModel(event.target.value)} placeholder="Provider model ID" />}</label>
            </div>
          </section>
          <section id="workspace"><h2>Workspace Configuration</h2><p>{workspacePath ? <>Saved to <code>{workspacePath}/.omnicode/settings.json</code>. Commands here are user-authored and run only when you explicitly start them.</> : 'Open a folder to configure workspace-specific behavior.'}</p>
            <textarea className="workspace-settings-json" aria-label="Workspace settings JSON" disabled={!workspacePath} spellCheck={false} value={workspaceJson} onChange={(event) => setWorkspaceJson(event.target.value)} />
            <button className="primary-button" disabled={!workspacePath} onClick={async () => {
              if (!workspacePath) return
              try {
                const value = JSON.parse(workspaceJson) as WorkspaceSettings
                await window.omnicode.settings.write(workspacePath, value)
                onWorkspaceSettings(value)
                setStatusError(false); setStatus('Workspace settings saved and applied.')
              }
              catch (cause) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
            }}>Save Workspace Settings</button>
          </section>
          <section id="permissions"><h2>AI Permissions</h2><p>Destructive, system, sudo, Keychain-read, and outside-workspace actions always require approval.</p>
            <div className="permission-options">{[
              ['ask', 'Ask Every Time', 'Review file and command actions individually.'],
              ['workspace', 'Workspace Access', 'Allow routine reads and writes inside the open workspace.'],
              ['agent', 'Agent Mode', 'Allow iterative work inside the workspace; dangerous operations still ask.']
            ].map(([id, name, detail]) => <button key={id} className={permission === id ? 'active' : ''} onClick={() => onPermission(id as typeof permission)}><Shield /><span><strong>{name}</strong><small>{detail}</small></span>{permission === id && <CheckCircle2 />}</button>)}</div>
          </section>
        </main>
      </div>
    </div>
  </div>
}
