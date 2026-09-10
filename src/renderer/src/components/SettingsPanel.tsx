import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, FolderClosed, Globe2, KeyRound, LoaderCircle, Mail, Plug, RefreshCw, Shield, Trash2, Unplug, X } from 'lucide-react'
import type { AIModel, AIProviderConnectionStatus, AIProviderId, ThemePreference, WorkspaceSettings } from '../../../shared/contracts'
import type { AIModelDescriptor, CloudAIProviderId } from '../../../shared/model-contracts'
import type { ConnectorDescriptor } from '../../../shared/tool-contracts'

type CloudProvider = Exclude<AIProviderId, 'ollama'>
const PROVIDERS: Array<{ id: CloudProvider; name: string; placeholder: string }> = [
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'anthropic', name: 'Anthropic Claude', placeholder: 'sk-ant-…' },
  { id: 'google', name: 'Google Gemini', placeholder: 'API key' }
]

function connectorStatusLabel(connector: ConnectorDescriptor): string {
  switch (connector.status.state) {
    case 'connected': return 'Connected & verified'
    case 'connecting': return 'Connecting…'
    case 'authentication-expired': return 'Reconnect required'
    case 'permission-missing': return 'Permission required'
    case 'network-error': return 'Network error'
    case 'rate-limited': return 'Rate limited'
    case 'service-unavailable': return 'Unavailable'
    default: return 'Not connected'
  }
}

function connectorScopeLabel(scope: string): string {
  if (scope.endsWith('/auth/gmail.modify')) return 'Read, organize, draft, and send Gmail messages'
  if (scope.endsWith('/auth/drive')) return 'View and manage Google Drive files'
  return scope
}

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
  const [connections, setConnections] = useState<Partial<Record<CloudProvider, AIProviderConnectionStatus>>>({})
  const [credentialBusy, setCredentialBusy] = useState<Partial<Record<CloudProvider, 'saving' | 'testing' | 'removing'>>>({})
  const [credentialErrors, setCredentialErrors] = useState<Partial<Record<CloudProvider, string>>>({})
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [workspaceJson, setWorkspaceJson] = useState('{}')
  const [localModels, setLocalModels] = useState<AIModel[]>([])
  const [cloudModels, setCloudModels] = useState<Partial<Record<CloudProvider, AIModelDescriptor[]>>>({})
  const [cloudModelsBusy, setCloudModelsBusy] = useState<CloudProvider | null>(null)
  const [cloudModelErrors, setCloudModelErrors] = useState<Partial<Record<CloudProvider, string>>>({})
  const [connectors, setConnectors] = useState<ConnectorDescriptor[]>([])
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null)
  const [connectorError, setConnectorError] = useState('')
  useEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', dismiss, true)
    return () => window.removeEventListener('keydown', dismiss, true)
  }, [onClose])

  const refreshCloudModels = async (provider: CloudProvider, forceRefresh = false): Promise<void> => {
    setCloudModelsBusy(provider)
    setCloudModelErrors((current) => ({ ...current, [provider]: undefined }))
    try {
      const result = await window.omnicode.ai.cloudModelCatalog(provider as CloudAIProviderId, { forceRefresh })
      const models = result.models.filter((model) => model.availability !== 'unavailable' && model.capabilities.chat.support !== 'unsupported')
      setCloudModels((current) => ({ ...current, [provider]: models }))
      if (autocompleteProvider === provider && !models.some((model) => model.id === autocompleteModel)) {
        onAutocompleteModel(models[0]?.id ?? '')
      }
      if (result.providerState === 'authentication-failed' || result.providerState === 'unavailable') {
        setCloudModelErrors((current) => ({ ...current, [provider]: result.message }))
      }
    } catch (cause) {
      setCloudModelErrors((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setCloudModelsBusy((current) => current === provider ? null : current)
    }
  }

  const refreshConnectors = async (verify = false): Promise<void> => {
    try {
      setConnectorError('')
      setConnectors(await window.omnicode.work.connectors.list(verify))
    } catch (cause) {
      setConnectorError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  useEffect(() => {
    let active = true
    for (const { id } of PROVIDERS) {
      void window.omnicode.ai.hasCredential(id)
        .then((value) => {
          if (!active) return
          setStored((current) => ({ ...current, [id]: value }))
          setConnections((current) => ({
            ...current,
            [id]: value
              ? { provider: id, state: 'stored', stored: true, message: 'Credential stored in macOS Keychain; connection not tested yet.' }
              : { provider: id, state: 'not-configured', stored: false, message: 'No API key is stored in macOS Keychain.' }
          }))
        })
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
    void refreshConnectors(true)
  }, [])
  useEffect(() => {
    if (autocompleteProvider !== 'ollama' && !cloudModels[autocompleteProvider]) {
      void refreshCloudModels(autocompleteProvider)
    }
  }, [autocompleteProvider])
  useEffect(() => {
    if (!workspacePath) return setWorkspaceJson('{}')
    void window.omnicode.settings.read(workspacePath).then((settings) => setWorkspaceJson(JSON.stringify(settings, null, 2))).catch((cause) => { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) })
  }, [workspacePath])
  const testConnection = async (provider: CloudProvider, keepBusy = false): Promise<AIProviderConnectionStatus | undefined> => {
    if (credentialBusy[provider] && !keepBusy) return
    if (!keepBusy) setCredentialBusy((current) => ({ ...current, [provider]: 'testing' }))
    setCredentialErrors((current) => ({ ...current, [provider]: undefined }))
    setStatus('')
    try {
      const result = await window.omnicode.ai.testProviderConnection(provider)
      setStored((current) => ({ ...current, [provider]: result.stored }))
      setConnections((current) => ({ ...current, [provider]: result }))
      setStatusError(result.state !== 'connected')
      setStatus(result.message)
      return result
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setCredentialErrors((current) => ({ ...current, [provider]: message }))
      setStatusError(true)
      setStatus(message)
      return undefined
    } finally {
      if (!keepBusy) setCredentialBusy((current) => ({ ...current, [provider]: undefined }))
    }
  }
  const saveKey = async (provider: CloudProvider): Promise<void> => {
    if (credentialBusy[provider]) return
    setCredentialBusy((current) => ({ ...current, [provider]: 'saving' }))
    setCredentialErrors((current) => ({ ...current, [provider]: undefined }))
    setStatus('')
    let saved = false
    try {
      await window.omnicode.ai.setCredential(provider, keys[provider])
      saved = true
      setStored((current) => ({ ...current, [provider]: true }))
      setKeys((current) => ({ ...current, [provider]: '' }))
      const result = await testConnection(provider, true)
      if (result) setStatus(`${PROVIDERS.find((item) => item.id === provider)!.name} API key saved securely. ${result.message}`)
    } catch (cause) {
      setStored((current) => ({ ...current, [provider]: saved ? true : null }))
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
      setConnections((current) => ({ ...current, [provider]: { provider, state: 'not-configured', stored: false, message: 'No API key is stored in macOS Keychain.' } }))
      setStatusError(false)
      setStatus(`${PROVIDERS.find((item) => item.id === provider)!.name} API key removed.`)
    } catch (cause) {
      setCredentialErrors((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) }))
    } finally { setCredentialBusy((current) => ({ ...current, [provider]: undefined })) }
  }
  const toggleConnector = async (connector: ConnectorDescriptor): Promise<void> => {
    if (connectorBusy) return
    setConnectorBusy(connector.id)
    setConnectorError('')
    try {
      if (connector.status.state === 'connected') await window.omnicode.work.connectors.disconnect(connector.id)
      else await window.omnicode.work.connectors.connect(connector.id)
      await refreshConnectors(true)
    } catch (cause) {
      setConnectorError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConnectorBusy(null)
    }
  }
  return <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
    <div className="settings-panel">
      <header><div><h1>Settings</h1><p>User settings · stored locally</p></div><button onClick={onClose} title="Close settings"><X /></button></header>
      <div className="settings-content">
        <nav><a href="#appearance">Appearance</a><a href="#files">Files & Autosave</a><a href="#providers">AI Providers</a><a href="#autocomplete">AI Autocomplete</a><a href="#work-mode">Work Mode</a><a href="#connected-apps">Connected Apps</a><a href="#workspace">Workspace</a><a href="#permissions">Permissions & Privacy</a></nav>
        <main>
          <section id="appearance"><h2>Appearance</h2><p>Choose how OmniCode follows macOS.</p>
            <div className="segmented">{(['system', 'dark', 'light'] as ThemePreference[]).map((item) => <button className={theme === item ? 'active' : ''} key={item} onClick={() => onTheme(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
          </section>
          <section id="files"><h2>Files & Autosave</h2><label className="setting-toggle"><span><strong>Autosave</strong><small>Save changed files after a short delay.</small></span><input type="checkbox" checked={autosave} onChange={(event) => onAutosave(event.target.checked)} /></label></section>
          <section id="providers"><h2>AI Providers</h2><p>Credentials are written to macOS Keychain and never to a workspace or log.</p>
            {PROVIDERS.map((provider) => <div className="provider-setting" key={provider.id} aria-busy={!!credentialBusy[provider.id]}>
              <div><KeyRound /><span><strong>{provider.name}</strong><small>{credentialBusy[provider.id] ? <><LoaderCircle className="spin" />{credentialBusy[provider.id] === 'saving' ? 'Saving and testing…' : credentialBusy[provider.id] === 'testing' ? 'Testing connection…' : 'Removing…'}</> : credentialErrors[provider.id] ? 'Keychain needs attention' : stored[provider.id] === null ? 'Checking Keychain…' : connections[provider.id]?.state === 'connected' ? <><CheckCircle2 /> Connected</> : connections[provider.id]?.state === 'authentication-failed' ? 'Authentication failed' : connections[provider.id]?.state === 'unavailable' ? 'Stored · Connection unavailable' : stored[provider.id] ? 'Credential stored · Not tested' : 'Not configured'}</small></span></div>
              <input aria-label={`${provider.name} API key`} type="password" autoComplete="off" disabled={!!credentialBusy[provider.id]} value={keys[provider.id]} placeholder={stored[provider.id] ? 'Replace saved credential' : provider.placeholder} onChange={(event) => setKeys((current) => ({ ...current, [provider.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && keys[provider.id].trim()) void saveKey(provider.id) }} />
              <button aria-label={`Save ${provider.name} API key`} disabled={!keys[provider.id].trim() || !!credentialBusy[provider.id]} onClick={() => void saveKey(provider.id)}>{credentialBusy[provider.id] === 'saving' ? 'Saving…' : 'Save'}</button>
              {stored[provider.id] && <button aria-label={`Test ${provider.name} connection`} disabled={!!credentialBusy[provider.id]} onClick={() => void testConnection(provider.id)}>{credentialBusy[provider.id] === 'testing' ? 'Testing…' : 'Test'}</button>}
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
                onAutocompleteModel(next === 'ollama' ? localModels[0]?.id ?? '' : cloudModels[next]?.[0]?.id ?? '')
              }}><option value="ollama">Ollama · local</option><option value="openai">OpenAI · cloud</option><option value="anthropic">Anthropic · cloud</option><option value="google">Google Gemini · cloud</option></select></label>
              <label><strong>Model</strong>{autocompleteProvider === 'ollama'
                ? <select value={autocompleteModel} onChange={(event) => onAutocompleteModel(event.target.value)}><option value="">Choose an installed model</option>{localModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
                : <span className="cloud-model-setting"><select aria-label={`${PROVIDERS.find((provider) => provider.id === autocompleteProvider)?.name ?? autocompleteProvider} autocomplete model`} value={autocompleteModel} disabled={cloudModelsBusy === autocompleteProvider} onChange={(event) => onAutocompleteModel(event.target.value)}>
                  {!cloudModels[autocompleteProvider]?.length && <option value="">{cloudModelsBusy === autocompleteProvider ? 'Loading available models…' : 'No compatible models available'}</option>}
                  {cloudModels[autocompleteProvider]?.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                </select><button type="button" className="icon-button" title="Refresh available cloud models" aria-label={`Refresh ${autocompleteProvider} autocomplete models`} disabled={cloudModelsBusy === autocompleteProvider} onClick={() => void refreshCloudModels(autocompleteProvider, true)}>{cloudModelsBusy === autocompleteProvider ? <LoaderCircle className="spin" /> : <RefreshCw />}</button></span>}</label>
              {autocompleteProvider !== 'ollama' && cloudModelErrors[autocompleteProvider] && <p className="provider-error" role="alert">{cloudModelErrors[autocompleteProvider]}</p>}
            </div>
          </section>
          <section id="work-mode"><h2>Work Mode</h2><p>Work Mode has its own persistent conversations and shares OmniCode’s secure AI provider and model infrastructure. The selected Work model is changed from the Work conversation header.</p>
            <div className="work-settings-summary"><Shield /><span><strong>Tool permissions stay in the main process</strong><small>AI-generated tool requests are schema-validated and checked before a connector can run. Write and high-impact actions require confirmation.</small></span></div>
          </section>
          <section id="connected-apps"><h2>Work Mode · Connected Apps</h2><p>Only real registered connectors appear here. A connector is shown as connected only after its own connection verification succeeds.</p>
            <div className="settings-connectors">
              {connectors.map((connector) => {
                const connected = connector.status.state === 'connected'
                const busy = connectorBusy === connector.id || connector.status.state === 'connecting'
                const ConnectorIcon = connector.id === 'gmail' ? Mail : connector.id === 'google-drive' ? FolderClosed : connector.id === 'browser' ? Globe2 : Plug
                const reconnect = connector.status.state === 'authentication-expired' || connector.status.state === 'permission-missing'
                return <article key={connector.id} className={`settings-connector state-${connector.status.state}`}>
                  <div className="settings-connector-heading"><span className="settings-connector-icon"><ConnectorIcon /></span><span><span className={`settings-connector-state state-${connector.status.state}`}>{connectorStatusLabel(connector)}</span><strong>{connector.name}</strong><small>{connector.status.message}</small></span></div>
                  <p>{connector.description}</p>
                  <ul>{connector.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul>
                  {!!connector.requestedScopes.length && <details className="settings-connector-permissions"><summary>Permissions requested</summary><ul>{connector.requestedScopes.map((scope) => <li key={scope}>{connectorScopeLabel(scope)}</li>)}</ul></details>}
                  {(connector.id === 'gmail' || connector.id === 'google-drive') && <small className="settings-connector-note">Google revocation disconnects both Gmail and Drive from OmniCode.</small>}
                  <div className="settings-connector-actions">
                    {(connector.id === 'gmail' || connector.id === 'google-drive') && connected && <button type="button" onClick={() => void window.omnicode.app.openExternal('https://myaccount.google.com/connections').catch((cause) => setConnectorError(cause instanceof Error ? cause.message : String(cause)))}><ExternalLink />Manage permissions</button>}
                    <button type="button" disabled={busy} className={connected ? 'disconnect' : 'primary-button'} onClick={() => void toggleConnector(connector)}>{busy ? <LoaderCircle className="spin" /> : connected ? <Unplug /> : <Plug />}{busy ? 'Working…' : connected ? 'Disconnect' : reconnect ? 'Reconnect' : 'Connect'}</button>
                  </div>
                </article>
              })}
              {!connectors.length && !connectorError && <div className="settings-empty-connector"><Plug /><span><strong>No connectors registered</strong><small>This build will not display simulated connected services.</small></span></div>}
            </div>
            {connectorError && <div className="settings-status error" role="alert">{connectorError}</div>}
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
          <section id="permissions"><h2>AI Permissions</h2><p>Every AI file change stays behind diff review. Agent commands are filtered in the main process and require native confirmation; dangerous, privileged, and Keychain-read commands are blocked.</p>
            <div className="permission-options">{[
              ['ask', 'Ask Every Time', 'Confirm cloud context for both Chat and Agent requests.'],
              ['workspace', 'Workspace Access', 'Allow chosen Chat context; Agent context still confirms each task.'],
              ['agent', 'Agent Mode', 'Allow chosen Chat and Agent context; edits and commands still require review.']
            ].map(([id, name, detail]) => <button key={id} className={permission === id ? 'active' : ''} onClick={() => onPermission(id as typeof permission)}><Shield /><span><strong>{name}</strong><small>{detail}</small></span>{permission === id && <CheckCircle2 />}</button>)}</div>
          </section>
        </main>
      </div>
    </div>
  </div>
}
