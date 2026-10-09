import { Fragment, useEffect, useState } from 'react'
import { AudioWaveform, Bell, CheckCircle2, ExternalLink, FolderClosed, Globe2, KeyRound, LoaderCircle, Mail, Mic, MousePointer2, Plug, RefreshCw, Shield, Trash2, Unplug, X, Zap } from 'lucide-react'
import type { AIModel, AIProviderConnectionStatus, AIProviderId, OllamaStatus, ProviderDataPolicy, ThemePreference, WorkspaceSettings } from '../../../shared/contracts'
import type { AIModelDescriptor, CloudAIProviderId } from '../../../shared/model-contracts'
import type { OmniPermissionId, OmniPermissionsSnapshot, OmniSettings, OmniSpeechInputAvailability } from '../../../shared/omni-contracts'
import type { ConnectorDescriptor, WorkApprovalMode, WorkPermissionSettings } from '../../../shared/tool-contracts'
import type { NotificationSettings } from '../../../shared/notification-contracts'
import type { MacOSPlatformSnapshot } from '../../../shared/platform-contracts'
import type { SpotlightSettings, SpotlightSettingsSnapshot } from '../../../shared/spotlight-contracts'
import { googleAccountSummary } from '../lib/google-account-status'
import { WORK_APPROVAL_MODES, WORK_APPROVAL_MODE_COPY } from '../lib/work-approval-mode'
import { FullAccessWarning } from './work/FullAccessWarning'
import { AIUsageDashboard } from './AIUsageDashboard'
import { ElevenLabsVoiceSettings } from './omni/ElevenLabsVoiceSettings'
import { OmniModeLogo } from './omni/OmniModeLogo'

type CloudProvider = Exclude<AIProviderId, 'ollama'>
const PROVIDERS: Array<{ id: CloudProvider; name: string; placeholder: string }> = [
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'anthropic', name: 'Anthropic Claude', placeholder: 'sk-ant-…' },
  { id: 'google', name: 'Google Gemini', placeholder: 'API key' }
]
const OMNI_PROVIDERS: Array<{ id: AIProviderId; name: string }> = [
  { id: 'ollama', name: 'Ollama · local' }, { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Claude' }, { id: 'google', name: 'Google Gemini' }
]
const OMNI_PERMISSIONS: Array<{ id: OmniPermissionId; name: string; detail: string }> = [
  { id: 'microphone', name: 'Microphone', detail: 'Voice input while Omni is listening' },
  { id: 'speech-recognition', name: 'Speech Recognition', detail: 'On-device voice transcription' },
  { id: 'accessibility', name: 'Accessibility', detail: 'Cursor Mode buttons, menus, and fields' },
  { id: 'notifications', name: 'Notifications', detail: 'Background completion alerts' },
  { id: 'automation', name: 'App Automation', detail: 'Authorized separately for each target app' },
  { id: 'files-and-folders', name: 'Files & Folders', detail: 'Folders you explicitly select' },
  { id: 'launch-at-login', name: 'Launch at Login', detail: 'Global Omni availability after sign-in' }
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
  onClose,
  onRestartTour
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
  onRestartTour(): void
}) {
  const [keys, setKeys] = useState<Record<CloudProvider, string>>({ openai: '', anthropic: '', google: '' })
  const [stored, setStored] = useState<Record<CloudProvider, boolean | null>>({ openai: null, anthropic: null, google: null })
  const [connections, setConnections] = useState<Partial<Record<CloudProvider, AIProviderConnectionStatus>>>({})
  const [credentialBusy, setCredentialBusy] = useState<Partial<Record<CloudProvider, 'saving' | 'testing' | 'removing'>>>({})
  const [credentialErrors, setCredentialErrors] = useState<Partial<Record<CloudProvider, string>>>({})
  const [providerPolicies, setProviderPolicies] = useState<Partial<Record<AIProviderId, ProviderDataPolicy>>>({})
  const [policyBusy, setPolicyBusy] = useState(false)
  const [confirmedGeminiPaid, setConfirmedGeminiPaid] = useState(false)
  const [confirmedGeminiProject, setConfirmedGeminiProject] = useState(false)
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [workspaceJson, setWorkspaceJson] = useState('{}')
  const [localModels, setLocalModels] = useState<AIModel[]>([])
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null)
  const [ollamaEndpoint, setOllamaEndpoint] = useState('http://127.0.0.1:11434')
  const [ollamaBusy, setOllamaBusy] = useState<'checking' | 'refreshing' | 'pulling' | 'selecting' | 'removing' | null>('checking')
  const [ollamaError, setOllamaError] = useState('')
  const [ollamaPullModel, setOllamaPullModel] = useState('')
  const [cloudModels, setCloudModels] = useState<Partial<Record<CloudProvider, AIModelDescriptor[]>>>({})
  const [cloudModelsBusy, setCloudModelsBusy] = useState<CloudProvider | null>(null)
  const [cloudModelErrors, setCloudModelErrors] = useState<Partial<Record<CloudProvider, string>>>({})
  const [connectors, setConnectors] = useState<ConnectorDescriptor[]>([])
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null)
  const [connectorError, setConnectorError] = useState('')
  const [workPermissions, setWorkPermissions] = useState<WorkPermissionSettings>({
    version: 1, globalMode: 'ask', connectorOverrides: {}, fullAccessWarningAcknowledged: false
  })
  const [permissionBusy, setPermissionBusy] = useState(false)
  const [fullAccessTarget, setFullAccessTarget] = useState<{ scope: 'global' | 'connector'; connectorId?: string } | null>(null)
  const [omniSettings, setOmniSettings] = useState<OmniSettings | null>(null)
  const [omniPermissions, setOmniPermissions] = useState<OmniPermissionsSnapshot | null>(null)
  const [omniVoices, setOmniVoices] = useState<Array<{ id: string; name: string; locale: string }>>([])
  const [omniVoiceInput, setOmniVoiceInput] = useState<OmniSpeechInputAvailability | null>(null)
  const [omniOnDeviceActive, setOmniOnDeviceActive] = useState(false)
  const [omniBusy, setOmniBusy] = useState(false)
  const [omniPermissionBusy, setOmniPermissionBusy] = useState<OmniPermissionId | null>(null)
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null)
  const [platform, setPlatform] = useState<MacOSPlatformSnapshot | null>(null)
  const [spotlightSettings, setSpotlightSettings] = useState<SpotlightSettingsSnapshot | null>(null)
  const [spotlightBusy, setSpotlightBusy] = useState(false)
  useEffect(() => { void window.omnicode.platform.snapshot().then(setPlatform).catch(() => undefined) }, [])
  useEffect(() => { void window.omnicode.spotlight.settings().then(setSpotlightSettings).catch(() => undefined) }, [])
  const updateSpotlight = async (changes: Partial<SpotlightSettings>): Promise<void> => {
    setSpotlightBusy(true)
    try {
      await window.omnicode.spotlight.updateSettings(changes)
      setSpotlightSettings(await window.omnicode.spotlight.settings())
    } catch (cause) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSpotlightBusy(false) }
  }
  const manageSpotlight = async (action: 'rebuild' | 'clear'): Promise<void> => {
    setSpotlightBusy(true)
    try {
      if (action === 'rebuild') await window.omnicode.spotlight.rebuild()
      else await window.omnicode.spotlight.clear()
      setSpotlightSettings(await window.omnicode.spotlight.settings())
      setStatusError(false)
      setStatus(action === 'rebuild' ? 'OmniCode Spotlight metadata was rebuilt.' : 'OmniCode Spotlight metadata was cleared and indexing was turned off.')
    } catch (cause) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSpotlightBusy(false) }
  }
  useEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[data-guided-tour]')) return
      event.preventDefault()
      if (fullAccessTarget) setFullAccessTarget(null)
      else onClose()
    }
    window.addEventListener('keydown', dismiss, true)
    return () => window.removeEventListener('keydown', dismiss, true)
  }, [fullAccessTarget, onClose])
  useEffect(() => {
    let active = true
    void window.omnicode.notifications.snapshot().then((snapshot) => {
      if (active) setNotificationSettings(snapshot.settings)
    }).catch((cause) => {
      if (active) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
    })
    const remove = window.omnicode.notifications.onChanged((snapshot) => {
      if (active) setNotificationSettings(snapshot.settings)
    })
    return () => { active = false; remove() }
  }, [])

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
      setConnectors((await window.omnicode.work.connectors.list(verify)).filter((connector) => connector.id !== 'system-native'))
    } catch (cause) {
      setConnectorError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const refreshProviderPolicies = async (): Promise<void> => {
    const entries = await Promise.all((['ollama', 'openai', 'anthropic', 'google'] as const).map(async (provider) =>
      [provider, await window.omnicode.work.providerPolicy(provider)] as const
    ))
    setProviderPolicies(Object.fromEntries(entries) as Partial<Record<AIProviderId, ProviderDataPolicy>>)
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
    let active = true
    void window.omnicode.notifications.snapshot().then((snapshot) => { if (active) setNotificationSettings(snapshot.settings) }).catch((cause) => {
      if (active) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
    })
    const remove = window.omnicode.notifications.onChanged((snapshot) => { if (active) setNotificationSettings(snapshot.settings) })
    return () => { active = false; remove() }
  }, [])
  useEffect(() => {
    let active = true
    void Promise.all([
      window.omnicode.ai.ollamaSettings(),
      window.omnicode.ai.ollamaStatus(),
      window.omnicode.ai.models()
    ]).then(([settings, nextStatus, models]) => {
      if (!active) return
      setOllamaEndpoint(settings.endpoint)
      setOllamaStatus(nextStatus)
      setLocalModels(models.filter((model) => model.installed !== false))
      if (autocompleteProvider === 'ollama' && !autocompleteModel && models[0]) onAutocompleteModel(models[0].id)
    }).catch((cause) => {
      if (active) setOllamaError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (active) setOllamaBusy(null) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    void refreshConnectors(true)
    void refreshProviderPolicies().catch((cause) => { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) })
  }, [])
  useEffect(() => {
    void window.omnicode.work.permissions.get().then(setWorkPermissions).catch((cause) => {
      setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause))
    })
    return window.omnicode.work.permissions.onChanged(setWorkPermissions)
  }, [])
  useEffect(() => {
    if (autocompleteProvider !== 'ollama' && !cloudModels[autocompleteProvider]) {
      void refreshCloudModels(autocompleteProvider)
    }
  }, [autocompleteProvider])
  useEffect(() => {
    let active = true
    void Promise.all([
      window.omnicode.omni.settings.get(),
      window.omnicode.omni.permissions.status(),
      window.omnicode.omni.voice.voices().catch(() => []),
      window.omnicode.omni.voice.inputAvailability().catch(() => null)
    ]).then(([nextSettings, nextPermissions, voices, input]) => {
      if (!active) return
      setOmniSettings(nextSettings)
      setOmniPermissions(nextPermissions)
      setOmniVoices(voices)
      setOmniVoiceInput(input)
    }).catch((cause) => {
      if (!active) return
      setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause))
    })
    const unsubscribe = window.omnicode.omni.settings.onChanged((next) => { if (active) setOmniSettings(next) })
    const unsubscribePermissions = window.omnicode.omni.permissions.onChanged((next) => { if (active) setOmniPermissions(next) })
    const unsubscribeVoice = window.omnicode.omni.voice.onInputEvent((event) => {
      if (event.type === 'diagnostic' && event.diagnostics) setOmniOnDeviceActive(event.diagnostics.onDeviceActive)
      if (event.type === 'final' || event.type === 'cancelled' || event.type === 'error') setOmniOnDeviceActive(false)
    })
    return () => { active = false; unsubscribe(); unsubscribePermissions(); unsubscribeVoice() }
  }, [])
  useEffect(() => {
    const provider = omniSettings?.model.provider
    if (provider && provider !== 'ollama' && !cloudModels[provider]) void refreshCloudModels(provider)
  }, [omniSettings?.model.provider])
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
      await refreshProviderPolicies()
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
      await refreshProviderPolicies()
    } catch (cause) {
      setCredentialErrors((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) }))
    } finally { setCredentialBusy((current) => ({ ...current, [provider]: undefined })) }
  }
  const refreshOllama = async (busy: 'checking' | 'refreshing' = 'refreshing'): Promise<void> => {
    if (ollamaBusy && ollamaBusy !== 'checking') return
    setOllamaBusy(busy); setOllamaError('')
    try {
      const [nextStatus, models] = await Promise.all([
        window.omnicode.ai.ollamaStatus(),
        window.omnicode.ai.models()
      ])
      setOllamaStatus(nextStatus)
      setLocalModels(models.filter((model) => model.installed !== false))
    } catch (cause) {
      setOllamaError(cause instanceof Error ? cause.message : String(cause))
    } finally { setOllamaBusy(null) }
  }
  const saveAndTestOllama = async (): Promise<void> => {
    if (ollamaBusy) return
    setOllamaBusy('checking'); setOllamaError('')
    try {
      const saved = await window.omnicode.ai.updateOllamaSettings({ endpoint: ollamaEndpoint })
      setOllamaEndpoint(saved.endpoint)
      const [nextStatus, models] = await Promise.all([
        window.omnicode.ai.ollamaStatus(),
        window.omnicode.ai.models()
      ])
      setOllamaStatus(nextStatus)
      setLocalModels(models.filter((model) => model.installed !== false))
    } catch (cause) {
      setOllamaError(cause instanceof Error ? cause.message : String(cause))
    } finally { setOllamaBusy(null) }
  }
  const selectOllamaModel = async (model: string): Promise<void> => {
    if (ollamaBusy) return
    setOllamaBusy('selecting'); setOllamaError('')
    try {
      const preferences = await window.omnicode.ai.selectModel(model)
      setLocalModels((current) => current.map((item) => ({ ...item, selected: item.id === preferences.selectedModel })))
    } catch (cause) { setOllamaError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOllamaBusy(null) }
  }
  const pullOllamaModel = async (): Promise<void> => {
    const model = ollamaPullModel.trim()
    if (!model || ollamaBusy) return
    setOllamaBusy('pulling'); setOllamaError('')
    try {
      const result = await window.omnicode.ai.pullModel(model)
      if (!result.cancelled) {
        setOllamaPullModel('')
        const models = await window.omnicode.ai.models()
        setLocalModels(models.filter((item) => item.installed !== false))
      }
    } catch (cause) { setOllamaError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOllamaBusy(null) }
  }
  const removeOllamaModel = async (model: string): Promise<void> => {
    if (ollamaBusy) return
    setOllamaBusy('removing'); setOllamaError('')
    try {
      const deleted = await window.omnicode.ai.deleteModel(model)
      if (deleted) setLocalModels((current) => current.filter((item) => item.id !== model))
    } catch (cause) { setOllamaError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOllamaBusy(null) }
  }
  const configureGeminiWorkspace = async (plan: 'paid' | 'free'): Promise<void> => {
    if (policyBusy) return
    setPolicyBusy(true); setStatus('')
    try {
      const policy = await window.omnicode.work.configureGeminiWorkspace({
        plan,
        ...(plan === 'paid' ? {
          confirmedAiStudioPlan: confirmedGeminiPaid,
          confirmedMatchingCredential: confirmedGeminiProject
        } : {})
      })
      setProviderPolicies((current) => ({ ...current, google: policy }))
      setConfirmedGeminiPaid(false); setConfirmedGeminiProject(false)
      setStatusError(false)
      setStatus(plan === 'paid'
        ? 'Gemini Paid Services eligibility recorded for this saved credential. Grant connected-data consent separately to enable Gmail and Drive.'
        : 'This Gemini credential is recorded as Free/Unpaid. Normal chat remains available; Gmail and Drive data stays blocked.')
    } catch (cause) {
      setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause))
    } finally { setPolicyBusy(false) }
  }
  const clearGeminiWorkspace = async (): Promise<void> => {
    if (policyBusy) return
    setPolicyBusy(true)
    try {
      const policy = await window.omnicode.work.clearGeminiWorkspaceVerification()
      setProviderPolicies((current) => ({ ...current, google: policy }))
      setStatusError(false); setStatus('Gemini Workspace compatibility reset to Unknown.')
    } catch (cause) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPolicyBusy(false) }
  }
  const setWorkspaceConsent = async (provider: AIProviderId, granted: boolean): Promise<void> => {
    if (policyBusy) return
    setPolicyBusy(true)
    try {
      const policy = await window.omnicode.work.setGoogleWorkspaceConsent(provider, granted)
      setProviderPolicies((current) => ({ ...current, [provider]: policy }))
      setStatusError(false)
      setStatus(granted ? `Connected-data consent enabled for ${policy.displayName}.` : `Connected-data consent removed for ${policy.displayName}.`)
    } catch (cause) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPolicyBusy(false) }
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
  const setGlobalWorkPermission = async (mode: WorkApprovalMode, acknowledge = false): Promise<void> => {
    if (mode === 'full' && !workPermissions.fullAccessWarningAcknowledged && !acknowledge) {
      setFullAccessTarget({ scope: 'global' })
      return
    }
    setPermissionBusy(true)
    try {
      setWorkPermissions(await window.omnicode.work.permissions.setGlobal(mode, acknowledge))
      setFullAccessTarget(null)
    } catch (cause) {
      setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause))
    } finally { setPermissionBusy(false) }
  }
  const setConnectorWorkPermission = async (connectorId: string, mode: WorkApprovalMode | null, acknowledge = false): Promise<void> => {
    if (mode === 'full' && !workPermissions.fullAccessWarningAcknowledged && !acknowledge) {
      setFullAccessTarget({ scope: 'connector', connectorId })
      return
    }
    setPermissionBusy(true)
    try {
      setWorkPermissions(await window.omnicode.work.permissions.setConnector(connectorId, mode, acknowledge))
      setFullAccessTarget(null)
    } catch (cause) {
      setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause))
    } finally { setPermissionBusy(false) }
  }
  const googleAccount = googleAccountSummary(connectors)
  const updateOmni = async (changes: Parameters<typeof window.omnicode.omni.settings.update>[0], acknowledge = false): Promise<void> => {
    if (omniBusy) return
    setOmniBusy(true)
    try { setOmniSettings(await window.omnicode.omni.settings.update(changes, acknowledge)) }
    catch (cause) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOmniBusy(false) }
  }
  const updateNotifications = async (changes: Partial<Omit<NotificationSettings, 'version'>>): Promise<void> => {
    try { setNotificationSettings((await window.omnicode.notifications.updateSettings(changes)).settings) }
    catch (cause) { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) }
  }
  const updateNativeNotifications = async (enabled: boolean): Promise<void> => {
    if (enabled) {
      try {
        const permission = await window.omnicode.omni.permissions.request('notifications')
        setOmniPermissions(await window.omnicode.omni.permissions.status())
        if (permission.state !== 'granted') {
          setStatusError(true)
          setStatus('macOS notification permission was not granted. The in-app Notification Center will continue to work.')
        }
      } catch (cause) {
        setStatusError(true)
        setStatus(cause instanceof Error ? cause.message : String(cause))
      }
    }
    await updateNotifications({ nativeMacOS: enabled })
  }
  const omniModelOptions = omniSettings?.model.provider === 'ollama'
    ? localModels.map((model) => ({ id: model.id, name: model.name }))
    : omniSettings ? (cloudModels[omniSettings.model.provider] ?? []).map((model) => ({ id: model.id, name: model.displayName })) : []
  return <><div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
    <div className="settings-panel">
      <header><div><h1>Settings</h1><p>User settings · stored locally</p></div><button onClick={onClose} title="Close settings"><X /></button></header>
      <div className="settings-content">
        <nav><a href="#appearance">Appearance</a><a href="#files">Files & Autosave</a><a href="#spotlight">Spotlight</a><a href="#notifications">Notifications</a><a href="#providers">AI Providers</a><a href="#ai-usage">AI Usage & Cost</a><a href="#autocomplete">AI Autocomplete</a><a href="#omni">Omni</a><a href="#work-mode">Work Mode</a><a href="#connected-apps">Connected Apps</a><a href="#workspace">Workspace</a><a href="#permissions">Permissions & Privacy</a><a href="#help">Help</a></nav>
        <main>
          {platform && <section id="platform"><h2>macOS Platform</h2><p>{platform.label} · minimum macOS {platform.minimumMacOS}</p><p>Running macOS {platform.actualMacOS} · {platform.architecture}</p><p>{platform.release === 'current' ? 'On-device Translation, Vision image text, and targeted window capture are available on supported hardware and with required permissions.' : 'Sonoma Legacy retains the shared Code, Work, and Omni features; macOS 15 native integrations are unavailable.'}</p></section>}
          <section id="spotlight"><h2>macOS Integration</h2><p>Make project names and eligible conversation titles searchable in macOS. Only metadata goes into the local Spotlight index—never workspace files, prompts, connector content, tokens, or terminal output.</p>
            {spotlightSettings && <div className="notification-settings-list" aria-busy={spotlightBusy}>
              <label className="setting-toggle"><span><strong>Spotlight integration</strong><small>{spotlightSettings.available ? 'Available on this Mac.' : 'System indexing is unavailable.'}</small></span><input type="checkbox" disabled={spotlightBusy || !spotlightSettings.available} checked={spotlightSettings.enabled} onChange={(event) => void updateSpotlight({ enabled: event.target.checked })} /></label>
              <label className="setting-toggle"><span><strong>Recent workspaces</strong><small>Indexes project names with opaque IDs, not paths or file contents.</small></span><input type="checkbox" disabled={spotlightBusy || !spotlightSettings.enabled} checked={spotlightSettings.recentWorkspaces} onChange={(event) => void updateSpotlight({ recentWorkspaces: event.target.checked })} /></label>
              <label className="setting-toggle"><span><strong>Conversation titles</strong><small>Indexes eligible Work titles only; conversations involving connected-app data are excluded.</small></span><input type="checkbox" disabled={spotlightBusy || !spotlightSettings.enabled} checked={spotlightSettings.conversationTitles} onChange={(event) => void updateSpotlight({ conversationTitles: event.target.checked })} /></label>
              <div className="ollama-provider-actions"><button type="button" disabled={spotlightBusy || !spotlightSettings.available || !spotlightSettings.enabled} onClick={() => void manageSpotlight('rebuild')}><RefreshCw />Rebuild OmniCode Index</button><button type="button" disabled={spotlightBusy || !spotlightSettings.available} onClick={() => void manageSpotlight('clear')}><Trash2 />Clear OmniCode Index</button></div>
              <p>Shortcuts: {platform?.release === 'legacy' ? '7' : '8'} navigation actions in the packaged macOS app. Some actions open OmniCode for further input.</p>
              <div className="ollama-provider-actions"><button type="button" onClick={() => void window.omnicode.platform.openShortcuts().catch((error) => setStatus(String(error)))}>Open Shortcuts</button></div>
              <small>Saved workflows and workspace filenames are not indexed in this release.</small>
            </div>}
          </section>
          <section id="appearance"><h2>Appearance</h2><p>Choose how OmniCode follows macOS.</p>
            <div className="segmented">{(['system', 'dark', 'light'] as ThemePreference[]).map((item) => <button className={theme === item ? 'active' : ''} key={item} onClick={() => onTheme(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
          </section>
          <section id="help"><h2>Help</h2><p>Explore the main OmniCode interface whenever you like.</p><button type="button" className="omni-rerun-setup" aria-label="Restart Tour" onClick={onRestartTour}><RefreshCw />Take OmniCode Tour</button></section>
          <section id="files"><h2>Files & Autosave</h2><label className="setting-toggle"><span><strong>Autosave</strong><small>Save changed files after a short delay.</small></span><input type="checkbox" checked={autosave} onChange={(event) => onAutosave(event.target.checked)} /></label></section>
          <section id="notifications"><h2>Notifications</h2><p>Keep important task outcomes visible in OmniCode and optionally mirror them to macOS.</p>
            {!notificationSettings ? <div className="omni-settings-loading"><LoaderCircle className="spin" />Loading notification settings…</div> : <div className="notification-settings-list">
              <label className="setting-toggle"><span><strong><Bell />In-app notifications</strong><small>Store recent outcomes in Notification Center. Activity inside conversations is always available.</small></span><input type="checkbox" checked={notificationSettings.inApp} onChange={(event) => void updateNotifications({ inApp: event.target.checked })} /></label>
              <label className="setting-toggle"><span><strong>macOS notifications</strong><small>Show native alerts only for important completions and failures, never individual tool actions.</small></span><input type="checkbox" checked={notificationSettings.nativeMacOS} onChange={(event) => void updateNativeNotifications(event.target.checked)} /></label>
              <label className="setting-toggle"><span><strong>Background task completion</strong><small>Notify when a task finishes after you navigate elsewhere.</small></span><input type="checkbox" checked={notificationSettings.backgroundCompletions} onChange={(event) => void updateNotifications({ backgroundCompletions: event.target.checked })} /></label>
              <label className="setting-toggle"><span><strong>Failures</strong><small>Notify when a task, connector, build, test, or download fails.</small></span><input type="checkbox" checked={notificationSettings.failures} onChange={(event) => void updateNotifications({ failures: event.target.checked })} /></label>
              <label className="setting-toggle"><span><strong>Email sent</strong><small>Notify after Gmail confirms that a message or reply was sent.</small></span><input type="checkbox" checked={notificationSettings.emailSent} onChange={(event) => void updateNotifications({ emailSent: event.target.checked })} /></label>
              <label className="setting-toggle"><span><strong>Builds finish</strong><small>Notify after Code Mode build activity completes or fails.</small></span><input type="checkbox" checked={notificationSettings.buildFinished} onChange={(event) => void updateNotifications({ buildFinished: event.target.checked })} /></label>
            </div>}
          </section>
          <section id="providers"><h2>AI Providers</h2><p>Credentials are written to macOS Keychain and never to a workspace or log. Ollama runs locally and does not require an API key.</p>
            <div className="ollama-provider-setting" aria-label="Ollama provider settings" aria-busy={!!ollamaBusy}>
              <div className="ollama-provider-heading"><div><Plug /><span><strong>Ollama · local</strong><small>{ollamaBusy === 'checking' ? 'Checking' : ollamaStatus?.state === 'connected' ? 'Connected' : ollamaStatus?.state === 'not-running' ? 'Not running' : ollamaStatus ? 'Unreachable' : 'Checking'}</small></span></div>{ollamaStatus?.version && <code>v{ollamaStatus.version}</code>}</div>
              <label className="ollama-endpoint"><strong>Server</strong><input aria-label="Ollama server endpoint" value={ollamaEndpoint} disabled={!!ollamaBusy} onChange={(event) => setOllamaEndpoint(event.target.value)} /><small>Loopback HTTP only. Default: http://127.0.0.1:11434</small></label>
              <div className="ollama-provider-actions"><button type="button" disabled={!!ollamaBusy || !ollamaEndpoint.trim()} onClick={() => void saveAndTestOllama()}>{ollamaBusy === 'checking' ? <LoaderCircle className="spin" /> : <Zap />}Test Connection</button><button type="button" disabled={!!ollamaBusy} onClick={() => void refreshOllama()}>{ollamaBusy === 'refreshing' ? <LoaderCircle className="spin" /> : <RefreshCw />}Refresh Models</button></div>
              <p className={`ollama-provider-status state-${ollamaStatus?.state ?? 'checking'}`}>{ollamaStatus?.message ?? 'Checking the configured local Ollama service…'}</p>
              <div className="ollama-installed-models"><div className="ollama-model-heading"><strong>Installed Models</strong><span>{localModels.length}</span></div>
                {!localModels.length && <p className="ollama-empty">No installed models were detected. Start Ollama, refresh the list, or pull a model below.</p>}
                {localModels.map((model) => <article key={model.id} className={model.selected ? 'selected' : ''}>
                  <div><strong>{model.name}</strong><code>{model.id}</code><small>{[model.parameterSize, model.quantization, model.family, model.size ? `${(model.size / 1024 ** 3).toFixed(1)} GB` : '', model.modelCapabilities?.toolMode === 'native' ? 'Native tools' : model.modelCapabilities?.toolMode === 'structured' ? 'Structured tool adapter' : 'Chat only'].filter(Boolean).join(' · ')}</small></div>
                  <button type="button" disabled={!!ollamaBusy || model.selected} onClick={() => void selectOllamaModel(model.id)}>{model.selected ? 'In use' : 'Use Model'}</button>
                  <button type="button" className="icon-button danger" title={`Remove ${model.name}`} disabled={!!ollamaBusy} onClick={() => void removeOllamaModel(model.id)}><Trash2 /></button>
                </article>)}
              </div>
              <div className="ollama-pull-model"><label><strong>Pull Model</strong><input aria-label="Ollama model to pull" placeholder="for example, qwen3:8b" value={ollamaPullModel} disabled={!!ollamaBusy} onChange={(event) => setOllamaPullModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void pullOllamaModel() }} /></label><button type="button" disabled={!!ollamaBusy || !ollamaPullModel.trim()} onClick={() => void pullOllamaModel()}>{ollamaBusy === 'pulling' ? 'Downloading…' : 'Pull Model'}</button><small>Installed models are discovered automatically. A native confirmation shows before any download.</small></div>
              {ollamaError && <p className="provider-error" role="alert">{ollamaError}</p>}
            </div>
            {PROVIDERS.map((provider) => <Fragment key={provider.id}><div className="provider-setting" aria-busy={!!credentialBusy[provider.id]}>
              <div><KeyRound /><span><strong>{provider.name}</strong><small>{credentialBusy[provider.id] ? <><LoaderCircle className="spin" />{credentialBusy[provider.id] === 'saving' ? 'Saving and testing…' : credentialBusy[provider.id] === 'testing' ? 'Testing connection…' : 'Removing…'}</> : credentialErrors[provider.id] ? 'Keychain needs attention' : stored[provider.id] === null ? 'Checking Keychain…' : connections[provider.id]?.state === 'connected' ? <><CheckCircle2 /> Connected</> : connections[provider.id]?.state === 'authentication-failed' ? 'Authentication failed' : connections[provider.id]?.state === 'unavailable' ? 'Stored · Connection unavailable' : stored[provider.id] ? 'Credential stored · Not tested' : 'Not configured'}</small></span></div>
              <input aria-label={`${provider.name} API key`} type="password" autoComplete="off" disabled={!!credentialBusy[provider.id]} value={keys[provider.id]} placeholder={stored[provider.id] ? 'Replace saved credential' : provider.placeholder} onChange={(event) => setKeys((current) => ({ ...current, [provider.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && keys[provider.id].trim()) void saveKey(provider.id) }} />
              <button aria-label={`Save ${provider.name} API key`} disabled={!keys[provider.id].trim() || !!credentialBusy[provider.id]} onClick={() => void saveKey(provider.id)}>{credentialBusy[provider.id] === 'saving' ? 'Saving…' : 'Save'}</button>
              {stored[provider.id] && <button aria-label={`Test ${provider.name} connection`} disabled={!!credentialBusy[provider.id]} onClick={() => void testConnection(provider.id)}>{credentialBusy[provider.id] === 'testing' ? 'Testing…' : 'Test'}</button>}
              {stored[provider.id] && <button className="icon-button danger" title={`Delete ${provider.name} credential`} disabled={!!credentialBusy[provider.id]} onClick={() => void deleteKey(provider.id)}><Trash2 /></button>}
              {credentialErrors[provider.id] && <p className="provider-error" role="alert">{credentialErrors[provider.id]}</p>}
            </div>{provider.id === 'google' && <div className="provider-policy-setting" aria-label="Gemini Workspace data compatibility">
              <div><strong>Workspace Data Compatibility</strong><span className={`policy-state state-${providerPolicies.google?.verificationState.toLowerCase() ?? 'unknown'}`}>{providerPolicies.google?.verificationState === 'VERIFIED_ELIGIBLE' ? 'Paid · Eligible' : providerPolicies.google?.verificationState === 'INELIGIBLE' ? 'Free · Ineligible' : providerPolicies.google?.verificationState === 'UNVERIFIED' ? 'Verification expired' : 'Unknown'}</span></div>
              <p>{providerPolicies.google?.rationale ?? 'Checking the saved Gemini configuration…'}</p>
              {providerPolicies.google?.verificationState === 'VERIFIED_ELIGIBLE' && <dl><div><dt>Data training</dt><dd>{providerPolicies.google.training}</dd></div><div><dt>Retention</dt><dd>{providerPolicies.google.retention}</dd></div><div><dt>Zero Data Retention</dt><dd>Not configured; Paid Services and zero data retention are separate.</dd></div></dl>}
              {providerPolicies.google?.verificationState !== 'VERIFIED_ELIGIBLE' && <div className="provider-policy-confirmations">
                <label><input type="checkbox" checked={confirmedGeminiPaid} onChange={(event) => setConfirmedGeminiPaid(event.target.checked)} />I confirmed the project used by this saved key shows <strong>Paid</strong> under Plan in Google AI Studio.</label>
                <label><input type="checkbox" checked={confirmedGeminiProject} onChange={(event) => setConfirmedGeminiProject(event.target.checked)} />I confirmed that Paid project is the project associated with this saved credential.</label>
              </div>}
              <div className="provider-policy-actions">
                <button type="button" disabled={policyBusy} onClick={() => void window.omnicode.app.openExternal('https://aistudio.google.com/apikey').catch((cause) => { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) })}><ExternalLink />Open AI Studio API Keys</button>
                {providerPolicies.google?.verificationState !== 'VERIFIED_ELIGIBLE' && <button type="button" disabled={policyBusy || !stored.google || !confirmedGeminiPaid || !confirmedGeminiProject} onClick={() => void configureGeminiWorkspace('paid')}>Verify Paid Configuration</button>}
                {providerPolicies.google?.verificationState !== 'INELIGIBLE' && <button type="button" disabled={policyBusy || !stored.google} onClick={() => void configureGeminiWorkspace('free')}>Mark as Free / Unpaid</button>}
                {(providerPolicies.google?.verificationState === 'VERIFIED_ELIGIBLE' || providerPolicies.google?.verificationState === 'INELIGIBLE') && <button type="button" disabled={policyBusy} onClick={() => void clearGeminiWorkspace()}>Reset Verification</button>}
              </div>
              <small>OmniCode cannot infer billing from a Gemini key. Paid confirmation is credential-bound, expires after seven days, and is cleared when the saved key changes.</small>
            </div>}</Fragment>)}
            {status && <div className={`settings-status${statusError ? ' error' : ''}`} role={statusError ? 'alert' : 'status'}>{status}</div>}
          </section>
          <section id="ai-usage"><h2>AI Usage & Cost</h2><p>Understand provider-reported token usage, estimated API cost, latency, and local-versus-cloud activity across Code, Work, and Omni.</p><AIUsageDashboard /></section>
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
          <section id="omni"><h2>Omni</h2><p>Configure the voice-first system assistant. These private settings are stored locally and use the existing provider and permission systems.</p>
            {!omniSettings ? <div className="omni-settings-loading"><LoaderCircle className="spin" />Loading Omni settings…</div> : <div className="omni-settings-groups">
              <div className="omni-settings-group"><h3><OmniModeLogo />General</h3>
                <label className="setting-toggle"><span><strong>Enable Omni</strong><small>Register the global activation shortcut and make Omni available.</small></span><input type="checkbox" disabled={omniBusy} checked={omniSettings.enabled} onChange={(event) => void updateOmni({ enabled: event.target.checked })} /></label>
                <button type="button" className="omni-rerun-setup" disabled={omniBusy} onClick={() => void window.omnicode.omni.settings.update({ setupCompleted: false }).then(() => onClose())}><RefreshCw />Setup & Permissions</button>
              </div>
              <div className="omni-settings-group"><h3><Mic />Voice</h3>
                <label className="setting-toggle"><span><strong>Spoken responses</strong><small>Let Omni read concise task responses aloud.</small></span><input type="checkbox" disabled={omniBusy} checked={omniSettings.voice.spokenResponses} onChange={(event) => void updateOmni({ voice: { spokenResponses: event.target.checked } })} /></label>
                <label className="omni-settings-select"><strong>Finish speaking</strong><select disabled={omniBusy} value={omniSettings.voice.finishSpeaking} onChange={(event) => void updateOmni({ voice: { finishSpeaking: event.target.value as 'auto' | 'enter' } })}><option value="auto">Automatically</option><option value="enter">Press Enter</option></select><small>Enter is always available as an immediate finish shortcut while Omni is listening. Escape cancels.</small></label>
                <label className="omni-settings-select"><strong>Microphone</strong><select disabled value="system-default"><option value="system-default">System Default — {omniVoiceInput?.inputDeviceName ?? 'Checking…'}</option></select><small>{omniVoiceInput?.channelCount
                  ? `${omniVoiceInput.inputDeviceTransport} · ${Math.round(omniVoiceInput.sampleRate).toLocaleString()} Hz · ${omniVoiceInput.channelCount} channel${omniVoiceInput.channelCount === 1 ? '' : 's'}`
                  : omniVoiceInput?.reason ?? 'Omni follows the current macOS system input device.'}</small></label>
                <div className="omni-settings-shortcut"><span><strong>On-device Speech</strong><small>{omniOnDeviceActive ? 'Active for the current voice session' : omniVoiceInput?.onDevice ? 'Available · required when listening' : 'Unavailable for the selected locale'}</small></span><b>{omniOnDeviceActive ? 'Active' : omniVoiceInput?.onDevice ? 'Available' : 'Unavailable'}</b></div>
                <details className="omni-settings-advanced"><summary>Advanced</summary><label className="omni-settings-select"><strong>End-of-speech delay</strong><select disabled={omniBusy || omniSettings.voice.finishSpeaking !== 'auto'} value={omniSettings.voice.endOfSpeechDelayMs} onChange={(event) => void updateOmni({ voice: { endOfSpeechDelayMs: Number(event.target.value) } })}><option value={1200}>1.2 seconds</option><option value={1600}>1.6 seconds</option><option value={2000}>2.0 seconds</option><option value={2500}>2.5 seconds</option></select><small>Used only after real speech has begun. Natural pauses shorter than this do not submit.</small></label></details>
                <ElevenLabsVoiceSettings voice={omniSettings.voice} busy={omniBusy} onUpdate={(voice) => updateOmni({ voice })} />
                {omniSettings.voice.outputProvider === 'system' && <div className="omni-settings-fields"><label><strong>macOS voice</strong><select disabled={omniBusy} value={omniSettings.voice.voiceId} onChange={(event) => void updateOmni({ voice: { voiceId: event.target.value } })}><option value="">System Default</option>{omniVoices.map((voice) => <option key={`${voice.id}-${voice.locale}`} value={voice.id}>{voice.name} · {voice.locale}</option>)}</select></label>
                  <button type="button" disabled={omniBusy} onClick={() => void window.omnicode.omni.voice.test().catch((cause) => { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) })}><AudioWaveform />Test Voice</button></div>}
              </div>
              <div className="omni-settings-group"><h3><Zap />Activation</h3>
                <div className="omni-settings-shortcut"><span><strong>Global shortcut</strong><small>Activate Omni from anywhere</small></span><kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd></div>
                <p className="omni-settings-note">Voice input is press-to-talk. This build does not run an always-listening wake-word service.</p>
                <label className="setting-toggle"><span><strong>Start Omni with my Mac</strong><small>Keep global activation available after login.</small></span><input type="checkbox" disabled={omniBusy} checked={omniSettings.launchHelperAtLogin} onChange={(event) => void updateOmni({ launchHelperAtLogin: event.target.checked })} /></label>
              </div>
              <div className="omni-settings-group"><h3><KeyRound />AI</h3><div className="omni-settings-fields two-fields">
                <label><strong>Provider</strong><select disabled={omniBusy} value={omniSettings.model.provider} onChange={(event) => {
                  const provider = event.target.value as AIProviderId
                  const options = provider === 'ollama' ? localModels.map((model) => model.id) : (cloudModels[provider as CloudProvider] ?? []).map((model) => model.id)
                  void updateOmni({ model: { provider, modelId: options[0] ?? '' } })
                }}>{OMNI_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
                <label><strong>Model</strong><select disabled={omniBusy || !omniModelOptions.length} value={omniSettings.model.modelId} onChange={(event) => void updateOmni({ model: { modelId: event.target.value } })}>{!omniModelOptions.length && <option value="">No available models</option>}{omniModelOptions.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
              </div></div>
              <div className="omni-settings-group"><h3><MousePointer2 />Execution</h3><div className="omni-settings-segments"><button type="button" className={omniSettings.executionMode === 'invisible' ? 'active' : ''} onClick={() => void updateOmni({ executionMode: 'invisible' })}><Zap />Invisible<small>Background when possible</small></button><button type="button" className={omniSettings.executionMode === 'cursor' ? 'active' : ''} onClick={() => void updateOmni({ executionMode: 'cursor' })}><MousePointer2 />Cursor<small>Visible Mac control</small></button></div></div>
              <div className="omni-settings-group"><h3><Shield />Approvals</h3><label className="omni-settings-select"><strong>Action approval</strong><select disabled={omniBusy} value={omniSettings.approvalMode} onChange={(event) => {
                const mode = event.target.value as WorkApprovalMode
                if (mode === 'full') {
                  if (!window.confirm('Full Access still protects critical, financial, account-security, and irreversible destructive actions. Enable it for Omni?')) return
                  void updateOmni({ approvalMode: mode }, true)
                } else void updateOmni({ approvalMode: mode })
              }}><option value="ask">Ask for approval</option><option value="auto">Approve for me</option><option value="full">Full access</option></select><small>Critical and irreversible actions always require direct approval.</small></label></div>
              <div className="omni-settings-group"><h3><AudioWaveform />Input</h3><label className="setting-toggle"><span><strong>Show text input</strong><small>Display a compact optional text field beneath the voice controls.</small></span><input type="checkbox" disabled={omniBusy} checked={omniSettings.showTextInput} onChange={(event) => void updateOmni({ showTextInput: event.target.checked })} /></label></div>
              <div className="omni-settings-group"><h3><Shield />Permissions</h3><p className="omni-settings-note">These controls request real macOS authorization. Scoped access is requested only when its associated action is used.</p><div className="omni-settings-permissions">{OMNI_PERMISSIONS.map((permission) => {
                const state = omniPermissions?.permissions[permission.id] ?? 'not-determined'
                const detail = omniPermissions?.details[permission.id]
                const enabled = state === 'granted'
                const actionable = detail?.canRequest ?? !enabled
                return <div key={permission.id} data-state={state}><span>{enabled ? <CheckCircle2 /> : <Shield />}</span><span><strong>{permission.name}</strong><small>{detail?.explanation ?? permission.detail}</small>{detail?.featureReason && <small>{detail.featureReason}</small>}</span><small>{state.replaceAll('-', ' ')}</small>{!enabled && actionable && <button type="button" disabled={omniPermissionBusy !== null} onClick={() => {
                  setOmniPermissionBusy(permission.id)
                  void window.omnicode.omni.permissions.request(permission.id).then(() => window.omnicode.omni.permissions.status()).then(setOmniPermissions).catch((cause) => {
                    setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause))
                  }).finally(() => setOmniPermissionBusy(null))
                }}>{omniPermissionBusy === permission.id ? 'Requesting…' : 'Enable'}</button>}{!enabled && detail?.canOpenSettings && !actionable && <button type="button" onClick={() => void window.omnicode.omni.permissions.openSettings(permission.id)}>Open Settings</button>}</div>
              })}</div><button type="button" className="omni-rerun-setup" onClick={() => void window.omnicode.omni.permissions.status().then(setOmniPermissions)}><RefreshCw />Refresh Permissions</button></div>
              <div className="omni-settings-group"><h3><Shield />Privacy</h3><p className="omni-settings-note">Cursor Mode uses macOS Accessibility and structured window information. It does not capture or retain screenshots in this build. Press-to-talk audio is transcribed with on-device Apple Speech Recognition and is not saved as an audio file.</p></div>
              <div className="omni-settings-group"><h3><RefreshCw />Activity</h3><label className="omni-settings-select"><strong>Keep activity for</strong><select disabled={omniBusy} value={omniSettings.privacy.activityRetentionDays} onChange={(event) => void updateOmni({ privacy: { activityRetentionDays: Number(event.target.value) } })}><option value={0}>Current session only</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={60}>60 days</option><option value={90}>90 days</option></select><small>The main dashboard renders only the 40 most recent events.</small></label></div>
            </div>}
          </section>
          <section id="work-mode"><h2>Work Mode</h2><p>Choose how OmniCode handles actions proposed by any Work model. This app-level setting is stored privately on this Mac and applies independently from Code Mode permissions.</p>
            <div className="work-settings-summary"><Shield /><span><strong>Tool permissions stay in the main process</strong><small>Cloud and local models use the same schema validation and backend permission policy. Instructions inside connected content cannot change it.</small></span></div>
            <h3 className="work-permission-heading">How should OmniCode approve Work actions?</h3>
            <div className="work-permission-options">{WORK_APPROVAL_MODES.map((mode) => <button type="button" disabled={permissionBusy} className={workPermissions.globalMode === mode ? 'active' : ''} key={mode} onClick={() => void setGlobalWorkPermission(mode)}><Shield /><span><strong>{WORK_APPROVAL_MODE_COPY[mode].label}</strong><small>{WORK_APPROVAL_MODE_COPY[mode].description}</small></span>{workPermissions.globalMode === mode && <CheckCircle2 />}</button>)}</div>
            <p className="work-permission-boundary"><strong>Always protected:</strong> critical actions, financial transactions, account-security changes, and irreversible destructive actions still need direct approval—even with Full access.</p>
          </section>
          <section id="connected-apps"><h2>Work Mode · Connected Apps</h2><p>Only real registered connectors appear here. A connector is shown as connected only after its own connection verification succeeds.</p>
            <div className="work-settings-summary"><Shield /><span><strong>Google OAuth</strong><small>OmniCode uses Google OAuth to access only the Google services and permissions you authorize. It never asks for your Google password.</small></span></div>
            {googleAccount && <div className={`settings-google-account state-${googleAccount.state}`}><span>{googleAccount.state === 'connected' ? <Shield /> : <Plug />}</span><span><strong>Google account</strong><small>{googleAccount.message}</small></span></div>}
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
                  <label className="settings-connector-approval"><strong>Action approval</strong><select disabled={permissionBusy} value={workPermissions.connectorOverrides[connector.id] ?? ''} onChange={(event) => void setConnectorWorkPermission(connector.id, event.target.value ? event.target.value as WorkApprovalMode : null)}><option value="">Use global · {WORK_APPROVAL_MODE_COPY[workPermissions.globalMode].shortLabel}</option>{WORK_APPROVAL_MODES.map((mode) => <option value={mode} key={mode}>{WORK_APPROVAL_MODE_COPY[mode].label}</option>)}</select><small>{workPermissions.connectorOverrides[connector.id] ? `Overrides the global setting for ${connector.name}.` : 'Follows the global Work Mode setting.'}</small></label>
                  <div className="settings-connector-actions">
                    {(connector.id === 'gmail' || connector.id === 'google-drive') && <button type="button" onClick={() => void window.omnicode.app.openExternal('https://omnicode.omnicoretech.org/privacy/').catch((cause) => setConnectorError(cause instanceof Error ? cause.message : String(cause)))}><ExternalLink />View Privacy Policy</button>}
                    {(connector.id === 'gmail' || connector.id === 'google-drive') && connected && <button type="button" onClick={() => void window.omnicode.app.openExternal('https://myaccount.google.com/connections').catch((cause) => setConnectorError(cause instanceof Error ? cause.message : String(cause)))}><ExternalLink />Manage Google Connection</button>}
                    <button type="button" disabled={busy} className={connected ? 'disconnect' : 'primary-button'} onClick={() => void toggleConnector(connector)}>{busy ? <LoaderCircle className="spin" /> : connected ? <Unplug /> : <Plug />}{busy ? 'Working…' : connected && (connector.id === 'gmail' || connector.id === 'google-drive') ? 'Disconnect Google' : connected ? 'Disconnect' : reconnect ? 'Reconnect' : 'Connect'}</button>
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
          <section id="permissions"><h2>Privacy & Security</h2><p>Every AI file change stays behind diff review. Agent commands are filtered in the main process and require native confirmation; dangerous, privileged, and Keychain-read commands are blocked.</p>
            <div className="permission-options">{[
              ['ask', 'Ask Every Time', 'Confirm cloud context for both Chat and Agent requests.'],
              ['workspace', 'Workspace Access', 'Allow chosen Chat context; Agent context still confirms each task.'],
              ['agent', 'Agent Mode', 'Allow chosen Chat and Agent context; edits and commands still require review.']
            ].map(([id, name, detail]) => <button key={id} className={permission === id ? 'active' : ''} onClick={() => onPermission(id as typeof permission)}><Shield /><span><strong>{name}</strong><small>{detail}</small></span>{permission === id && <CheckCircle2 />}</button>)}</div>
            <h3 className="work-permission-heading">Cloud AI & Connected Data</h3>
            <p>Google Workspace content is sent only when the provider is eligible and you separately allow minimum necessary Gmail or Drive data. OAuth tokens, API keys, authorization headers, and Keychain data are never included.</p>
            <div className="connected-data-policies">{(['openai', 'anthropic', 'google'] as const).map((provider) => {
              const policy = providerPolicies[provider]
              const providerName = PROVIDERS.find((item) => item.id === provider)?.name ?? provider
              return <article key={provider} data-enabled={policy?.allowsGoogleWorkspaceData === true}>
                <div><Shield /><span><strong>{providerName}</strong><small>{!policy ? 'Checking policy…' : !policy.workspaceDataEligible ? 'Not eligible with current configuration' : policy.consentGranted ? 'Minimum connected data allowed' : 'Eligible · consent not granted'}</small></span></div>
                <p>{policy?.rationale}</p>
                {policy?.workspaceDataEligible && <button type="button" disabled={policyBusy || !stored[provider]} onClick={() => void setWorkspaceConsent(provider, !policy.consentGranted)}>{policy.consentGranted ? 'Remove Consent' : 'Allow Minimum Connected Data'}</button>}
              </article>
            })}</div>
            <div className="settings-connector-actions">
              <button type="button" onClick={() => void window.omnicode.app.openExternal('https://omnicode.omnicoretech.org/privacy/').catch((cause) => { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) })}><ExternalLink />Privacy Policy</button>
              <button type="button" onClick={() => void window.omnicode.app.openExternal('https://omnicode.omnicoretech.org/terms/').catch((cause) => { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) })}><ExternalLink />Terms of Service</button>
              <button type="button" onClick={() => void window.omnicode.app.openExternal('https://omnicode.omnicoretech.org/about/').catch((cause) => { setStatusError(true); setStatus(cause instanceof Error ? cause.message : String(cause)) })}><ExternalLink />About OmniCode</button>
            </div>
          </section>
        </main>
      </div>
    </div>
  </div>{fullAccessTarget && <FullAccessWarning busy={permissionBusy} onCancel={() => setFullAccessTarget(null)} onEnable={() => {
    if (fullAccessTarget.scope === 'connector' && fullAccessTarget.connectorId) void setConnectorWorkPermission(fullAccessTarget.connectorId, 'full', true)
    else void setGlobalWorkPermission('full', true)
  }} />}</>
}
