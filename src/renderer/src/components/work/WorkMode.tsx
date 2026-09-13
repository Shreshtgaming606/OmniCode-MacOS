import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FolderClosed, Globe2, LoaderCircle, Mail, Plug, ShieldCheck, Unplug, X } from 'lucide-react'

import type { AIModel, AIProviderId } from '../../../../shared/contracts'
import type {
  AIModelCatalogResult,
  AIModelCapabilities,
  AIModelDescriptor,
  CloudAIProviderId
} from '../../../../shared/model-contracts'
import { unknownModelCapabilities } from '../../../../shared/model-contracts'
import type { ConnectorDescriptor } from '../../../../shared/tool-contracts'
import type {
  WorkAgentChatRequest,
  WorkAttachment,
  WorkConversation,
  WorkConversationSummary,
  WorkMessage
} from '../../../../shared/work-contracts'
import { storedAIProvider } from '../../lib/preferences'
import { googleAccountSummary } from '../../lib/google-account-status'
import { WorkModeShell, type WorkConnectedAppSummary } from './WorkModeShell'
import './WorkMode.css'

const CLOUD_PROVIDERS = new Set<AIProviderId>(['openai', 'anthropic', 'google'])

export interface WorkModeProps {
  active: boolean
  onOpenSettings(): void
  onError(error: unknown): void
  requestText(options: { title: string; label: string; value?: string; confirmLabel: string }): Promise<string | null>
}

function supportedCapabilities(model: AIModel): AIModelCapabilities {
  const capabilities = unknownModelCapabilities()
  capabilities.chat = { support: 'supported', evidence: 'ollama-show' }
  capabilities.streaming = { support: 'supported', evidence: 'ollama-show' }
  if (model.toolUse === true) capabilities['tool-calling'] = { support: 'supported', evidence: 'ollama-show' }
  if (model.capabilities?.some((capability) => /vision|image/iu.test(capability))) {
    capabilities.vision = { support: 'supported', evidence: 'ollama-show' }
  }
  if (model.codingCapability && model.codingCapability !== 'General') {
    capabilities.coding = { support: 'supported', evidence: 'maintained-metadata' }
  }
  if (model.contextWindow) {
    capabilities['large-context'] = {
      support: model.contextWindow >= 128_000 ? 'supported' : 'unsupported',
      evidence: 'ollama-show'
    }
  }
  return capabilities
}

export function localModelDescriptor(model: AIModel): AIModelDescriptor {
  return {
    id: model.id,
    provider: 'ollama',
    displayName: model.name || model.id,
    description: model.description,
    local: true,
    availability: model.installed === false ? 'unavailable' : 'available',
    contextWindow: model.contextWindow,
    capabilities: supportedCapabilities(model),
    metadataSource: model.installed === false ? 'curated' : 'installed'
  }
}

export function conversationTitle(message: string): string {
  const normalized = message.replace(/\s+/gu, ' ').trim()
  if (!normalized) return 'New chat'
  return normalized.length > 60 ? `${normalized.slice(0, 59).trimEnd()}…` : normalized
}

export function humanizeWorkError(cause: unknown): string {
  const raw = (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .trim()
  const providerFailure = raw.match(/^AI provider returned (\d{3}):\s*([\s\S]+)$/u)
  if (providerFailure) {
    try {
      const parsed = JSON.parse(providerFailure[2]) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) {
        return `${parsed.error.message.trim()} (HTTP ${providerFailure[1]})`.slice(0, 1_000)
      }
    } catch { /* fall through to the bounded provider error */ }
  }
  return (raw || 'The Work request failed.').slice(0, 1_000)
}

function modelStorageKey(provider: AIProviderId): string {
  return `omnicode.workModel.${provider}`
}

function safeStoredModel(provider: AIProviderId): string {
  const value = localStorage.getItem(modelStorageKey(provider))
  return value && value.length <= 256 && !/[\r\n\0]/u.test(value) ? value : ''
}

function connectorSummaries(connectors: ConnectorDescriptor[]): WorkConnectedAppSummary[] {
  return connectors.map((connector) => ({
    id: connector.id,
    name: connector.name,
    state: connector.status.state,
    capabilities: [...connector.capabilities],
    detail: connector.status.message
  }))
}

function connectionLabel(connector: ConnectorDescriptor): string {
  switch (connector.status.state) {
    case 'connected': return 'Connected and verified'
    case 'connecting': return 'Connecting…'
    case 'authentication-expired': return 'Authentication expired'
    case 'permission-missing': return 'Permission missing'
    case 'network-error': return 'Network error'
    case 'rate-limited': return 'Rate limited'
    case 'service-unavailable': return 'Unavailable'
    default: return 'Not connected'
  }
}

function ConnectedAppsDialog({
  connectors,
  busyId,
  onClose,
  onToggle,
  onOpenBrowser,
  onManageGoogle
}: {
  connectors: ConnectorDescriptor[]
  busyId: string | null
  onClose(): void
  onToggle(connector: ConnectorDescriptor): void
  onOpenBrowser(): void
  onManageGoogle(): void
}) {
  useEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', dismiss, true)
    return () => window.removeEventListener('keydown', dismiss, true)
  }, [onClose])
  const googleAccount = googleAccountSummary(connectors)
  return <div className="modal-backdrop work-apps-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="work-apps-dialog" role="dialog" aria-modal="true" aria-label="Connected Apps">
      <header><div><Plug /><span><h2>Connected Apps</h2><small>Only verified connections are shown as connected.</small></span></div><button type="button" autoFocus title="Close Connected Apps" onClick={onClose}><X /></button></header>
      <div className="work-apps-notice"><ShieldCheck /><span><strong>Permission boundary</strong><small>Connections, OAuth tokens, and tool permissions stay in OmniCode’s main process. Read tools are bounded; account changes require confirmation, and email is never sent without exact-content approval.</small></span></div>
      <div className="work-apps-list">
        {googleAccount && <div className={`work-google-account state-${googleAccount.state}`}><span>{googleAccount.state === 'connected' ? <ShieldCheck /> : <Plug />}</span><span><strong>Google account</strong><small>{googleAccount.message}</small></span></div>}
        {connectors.map((connector) => {
          const connected = connector.status.state === 'connected'
          const busy = busyId === connector.id || connector.status.state === 'connecting'
          const ConnectorIcon = connector.id === 'gmail' ? Mail : connector.id === 'google-drive' ? FolderClosed : connector.id === 'browser' ? Globe2 : Plug
          const reconnect = connector.status.state === 'authentication-expired' || connector.status.state === 'permission-missing'
          return <article className="work-app-card" key={connector.id}>
            <div className={`work-app-card-icon${connected ? ' connected' : ''}`}>{busy ? <LoaderCircle className="spin" /> : <ConnectorIcon />}</div>
            <div className="work-app-card-copy"><div><h3>{connector.name}</h3><span className={`state-${connector.status.state}`}>{connectionLabel(connector)}</span></div><p>{connector.description}</p><ul>{connector.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul><small>{connector.status.message}</small></div>
            <div className="work-app-card-actions">
              {connector.id === 'browser' && connected && <button type="button" onClick={onOpenBrowser}><ExternalLink />Open page</button>}
              {(connector.id === 'gmail' || connector.id === 'google-drive') && connected && <button type="button" onClick={onManageGoogle}><ExternalLink />Manage permissions</button>}
              <button type="button" className={connected ? 'disconnect' : 'connect'} disabled={busy} onClick={() => onToggle(connector)}>{busy ? <LoaderCircle className="spin" /> : connected ? <Unplug /> : <Plug />}{busy ? 'Working…' : connected ? 'Disconnect' : reconnect ? 'Reconnect' : 'Connect'}</button>
            </div>
          </article>
        })}
        {!connectors.length && <div className="work-apps-empty"><Plug /><p>No real connectors are registered in this build.</p></div>}
      </div>
    </section>
  </div>
}

export function WorkMode({ active, onOpenSettings, onError, requestText }: WorkModeProps) {
  const initialProvider = storedAIProvider(localStorage, 'omnicode.workProvider', 'ollama')
  const [conversations, setConversations] = useState<WorkConversationSummary[]>([])
  const [currentConversation, setCurrentConversation] = useState<WorkConversation | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [composerValue, setComposerValue] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<WorkAttachment[]>([])
  const [selectedProvider, setSelectedProvider] = useState<AIProviderId>(initialProvider)
  const [selectedModelId, setSelectedModelId] = useState(() => safeStoredModel(initialProvider))
  const [modelCatalog, setModelCatalog] = useState<AIModelDescriptor[]>([])
  const [modelState, setModelState] = useState<AIModelCatalogResult | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelError, setModelError] = useState<string | undefined>()
  const [connectors, setConnectors] = useState<ConnectorDescriptor[]>([])
  const [showConnectedApps, setShowConnectedApps] = useState(false)
  const [connectorBusyId, setConnectorBusyId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const mounted = useRef(true)
  const modelRequest = useRef(0)
  const activeRequest = useRef<{ requestId: string; conversationId: string; messageId: string } | null>(null)
  const streamedContent = useRef('')
  const cancelRequested = useRef(new Set<string>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const active = activeRequest.current
      if (active) void window.omnicode.work.agent.cancel(active.requestId)
    }
  }, [])

  useEffect(() => window.omnicode.work.agent.onEvent((event) => {
    const active = activeRequest.current
    if (!active || event.requestId !== active.requestId || event.type !== 'delta' || !event.delta) return
    streamedContent.current += event.delta
    setCurrentConversation((conversation) => {
      if (!conversation || conversation.id !== active.conversationId) return conversation
      return {
        ...conversation,
        messages: conversation.messages.map((message) => message.id === active.messageId
          ? { ...message, content: streamedContent.current, status: 'streaming' }
          : message)
      }
    })
  }), [])

  const refreshConversationList = useCallback(async (query = searchQuery): Promise<WorkConversationSummary[]> => {
    const next = query.trim()
      ? await window.omnicode.work.conversations.search({ query, limit: 100 })
      : await window.omnicode.work.conversations.list()
    if (mounted.current) setConversations(next)
    return next
  }, [searchQuery])

  const refreshConnectors = useCallback(async (refresh = false): Promise<void> => {
    const next = await window.omnicode.work.connectors.list(refresh)
    if (mounted.current) setConnectors(next)
  }, [])

  const refreshModels = useCallback(async (provider: AIProviderId, forceRefresh = false): Promise<AIModelDescriptor[]> => {
    const requestId = ++modelRequest.current
    setModelsLoading(true)
    setModelError(undefined)
    try {
      let models: AIModelDescriptor[]
      if (provider === 'ollama') {
        models = (await window.omnicode.ai.models()).map(localModelDescriptor)
        if (requestId === modelRequest.current && mounted.current) setModelState(null)
      } else {
        const result = await window.omnicode.ai.cloudModelCatalog(provider as CloudAIProviderId, { forceRefresh })
        models = result.models
        if (requestId === modelRequest.current && mounted.current) {
          setModelState(result)
          if (result.providerState === 'authentication-failed' || result.providerState === 'unavailable') setModelError(result.message)
        }
      }
      if (requestId === modelRequest.current && mounted.current) {
        setModelCatalog((current) => [...current.filter((model) => model.provider !== provider), ...models])
        setSelectedModelId((current) => {
          const preferred = current || safeStoredModel(provider)
          if (models.some((model) => model.id === preferred && model.availability !== 'unavailable')) return preferred
          const fallback = models.find((model) => model.availability !== 'unavailable' && model.capabilities.chat.support !== 'unsupported')?.id ?? ''
          if (fallback) localStorage.setItem(modelStorageKey(provider), fallback)
          return fallback
        })
      }
      return models
    } catch (cause) {
      const message = humanizeWorkError(cause)
      if (requestId === modelRequest.current && mounted.current) setModelError(message)
      return []
    } finally {
      if (requestId === modelRequest.current && mounted.current) setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.all([
      refreshConversationList('').then(async (items) => {
        if (!items[0] || !mounted.current) return
        const conversation = await window.omnicode.work.conversations.get(items[0].id)
        if (!mounted.current) return
        setCurrentConversation(conversation)
        setSelectedProvider(conversation.provider)
        setSelectedModelId(conversation.modelId)
        localStorage.setItem('omnicode.workProvider', conversation.provider)
        void refreshModels(conversation.provider)
      }),
      refreshConnectors(true),
      refreshModels(initialProvider)
    ]).catch(onError)
  // Initial application hydration is intentionally one-shot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshConversationList(searchQuery).catch(onError) }, 180)
    return () => window.clearTimeout(timer)
  }, [searchQuery, refreshConversationList, onError])

  useEffect(() => {
    if (active) void refreshConnectors(true).catch(onError)
  }, [active, refreshConnectors, onError])

  const selectConversation = async (id: string): Promise<void> => {
    try {
      const conversation = await window.omnicode.work.conversations.get(id)
      setCurrentConversation(conversation)
      setSelectedProvider(conversation.provider)
      setSelectedModelId(conversation.modelId)
      localStorage.setItem('omnicode.workProvider', conversation.provider)
      await refreshModels(conversation.provider)
      setError(undefined)
    } catch (cause) { onError(cause) }
  }

  const createConversation = async (): Promise<void> => {
    try {
      const conversation = await window.omnicode.work.conversations.create({
        provider: selectedProvider,
        modelId: selectedModelId
      })
      setCurrentConversation(conversation)
      setSearchQuery('')
      setComposerValue('')
      setError(undefined)
      await refreshConversationList('')
    } catch (cause) { onError(cause) }
  }

  const renameConversation = async (id: string): Promise<void> => {
    const existing = conversations.find((conversation) => conversation.id === id)
    if (!existing) return
    const title = await requestText({ title: 'Rename Work conversation', label: 'Conversation name', value: existing.title, confirmLabel: 'Rename' })
    if (!title) return
    try {
      const updated = await window.omnicode.work.conversations.update(id, { title })
      if (currentConversation?.id === id) setCurrentConversation(updated)
      await refreshConversationList()
    } catch (cause) { onError(cause) }
  }

  const deleteConversation = async (id: string): Promise<void> => {
    const existing = conversations.find((conversation) => conversation.id === id)
    if (!existing || !window.confirm(`Delete “${existing.title}”?\n\nThis removes the conversation from this Mac and cannot be undone.`)) return
    try {
      await window.omnicode.work.conversations.delete(id)
      const next = await refreshConversationList()
      if (currentConversation?.id === id) {
        setCurrentConversation(next[0] ? await window.omnicode.work.conversations.get(next[0].id) : null)
      }
    } catch (cause) { onError(cause) }
  }

  const togglePin = async (id: string, pinned: boolean): Promise<void> => {
    try {
      const updated = await window.omnicode.work.conversations.update(id, { pinned })
      if (currentConversation?.id === id) setCurrentConversation(updated)
      await refreshConversationList()
    } catch (cause) { onError(cause) }
  }

  const changeProvider = async (provider: AIProviderId): Promise<void> => {
    setSelectedProvider(provider)
    setSelectedModelId(safeStoredModel(provider))
    localStorage.setItem('omnicode.workProvider', provider)
    const models = await refreshModels(provider)
    const modelId = safeStoredModel(provider) || models.find((model) => model.availability !== 'unavailable' && model.capabilities.chat.support !== 'unsupported')?.id || ''
    setSelectedModelId(modelId)
    if (currentConversation) {
      try {
        const updated = await window.omnicode.work.conversations.update(currentConversation.id, { provider, modelId })
        setCurrentConversation(updated)
        await refreshConversationList()
      } catch (cause) { onError(cause) }
    }
  }

  const changeModel = async (modelId: string): Promise<void> => {
    setSelectedModelId(modelId)
    if (modelId) localStorage.setItem(modelStorageKey(selectedProvider), modelId)
    if (!currentConversation) return
    try {
      const updated = await window.omnicode.work.conversations.update(currentConversation.id, { provider: selectedProvider, modelId })
      setCurrentConversation(updated)
      await refreshConversationList()
    } catch (cause) { onError(cause) }
  }

  const requestAssistantResponse = async (
    conversation: WorkConversation,
    pendingAssistantId: string,
    messages: WorkAgentChatRequest['messages']
  ): Promise<void> => {
    let requestId: string | undefined
    try {
      requestId = crypto.randomUUID()
      streamedContent.current = ''
      activeRequest.current = { requestId, conversationId: conversation.id, messageId: pendingAssistantId }
      const response = await window.omnicode.work.agent.chat(requestId, {
        provider: selectedProvider,
        model: selectedModelId,
        messages
      })
      if (response.cancelled) {
        const stoppedContent = streamedContent.current.trim() || 'Generation stopped.'
        await window.omnicode.work.conversations.updateMessage(conversation.id, pendingAssistantId, {
          content: stoppedContent,
          status: 'cancelled',
          toolActivities: response.toolActivities
        })
        setCurrentConversation(await window.omnicode.work.conversations.get(conversation.id))
        await refreshConversationList('')
        return
      }
      if (!response.content.trim()) throw new Error('The AI provider returned an empty response.')
      await window.omnicode.work.conversations.updateMessage(conversation.id, pendingAssistantId, {
        content: response.content,
        status: 'complete',
        toolActivities: response.toolActivities
      })
      setCurrentConversation(await window.omnicode.work.conversations.get(conversation.id))
      await refreshConversationList('')
    } catch (cause) {
      const cancelled = Boolean(requestId && cancelRequested.current.has(requestId))
      const message = cancelled ? 'Generation stopped.' : humanizeWorkError(cause)
      setError(cancelled ? undefined : message)
      await window.omnicode.work.conversations.updateMessage(conversation.id, pendingAssistantId, {
        content: cancelled ? streamedContent.current.trim() || message : `Request failed: ${message}`,
        status: cancelled ? 'cancelled' : 'failed'
      }).catch(() => undefined)
      setCurrentConversation(await window.omnicode.work.conversations.get(conversation.id).catch(() => conversation))
    } finally {
      if (requestId) cancelRequested.current.delete(requestId)
      if (activeRequest.current?.requestId === requestId) activeRequest.current = null
      streamedContent.current = ''
    }
  }

  const send = async (content: string): Promise<void> => {
    if (sending || !selectedModelId) return
    setSending(true)
    setError(undefined)
    setComposerValue('')
    try {
      let conversation = currentConversation
      if (!conversation) {
        conversation = await window.omnicode.work.conversations.create({
          title: conversationTitle(content), provider: selectedProvider, modelId: selectedModelId
        })
      } else if (!conversation.messages.length && conversation.title === 'New chat') {
        conversation = await window.omnicode.work.conversations.update(conversation.id, { title: conversationTitle(content) })
      }
      await window.omnicode.work.conversations.update(conversation.id, { provider: selectedProvider, modelId: selectedModelId })
      await window.omnicode.work.conversations.addMessage(conversation.id, {
        role: 'user', content, status: 'complete', attachments: pendingAttachments
      })
      setPendingAttachments([])
      const requestConversation = await window.omnicode.work.conversations.get(conversation.id)
      const pending = await window.omnicode.work.conversations.addMessage(conversation.id, { role: 'assistant', content: '', status: 'pending' })
      const pendingConversation = await window.omnicode.work.conversations.get(conversation.id)
      setCurrentConversation(pendingConversation)
      await refreshConversationList('')
      await requestAssistantResponse(
        pendingConversation,
        pending.id,
        requestConversation.messages
          .filter((message) => message.status !== 'failed' && message.status !== 'cancelled')
          .map((message) => ({
            role: message.role,
            content: message.content,
            attachmentIds: message.attachments?.map((attachment) => attachment.id)
          }))
      )
    } catch (cause) {
      setError(humanizeWorkError(cause))
    } finally {
      if (mounted.current) setSending(false)
    }
  }

  const regenerateMessage = async (messageId: string): Promise<void> => {
    const conversation = currentConversation
    if (sending || !conversation || !selectedModelId) return
    const index = conversation.messages.findIndex((message) => message.id === messageId)
    if (index < 0 || index !== conversation.messages.length - 1 || conversation.messages[index]?.role !== 'assistant') return
    const requestMessages = conversation.messages.slice(0, index)
      .filter((message) => message.status !== 'failed' && message.status !== 'cancelled' && message.status !== 'pending')
      .map((message) => ({
        role: message.role,
        content: message.content,
        attachmentIds: message.attachments?.map((attachment) => attachment.id)
      }))
    if (!requestMessages.some((message) => message.role === 'user')) return
    setSending(true)
    setError(undefined)
    try {
      await window.omnicode.work.conversations.updateMessage(conversation.id, messageId, {
        content: '', status: 'pending', toolActivities: []
      })
      const pendingConversation = await window.omnicode.work.conversations.get(conversation.id)
      setCurrentConversation(pendingConversation)
      await requestAssistantResponse(pendingConversation, messageId, requestMessages)
    } catch (cause) {
      setError(humanizeWorkError(cause))
    } finally {
      if (mounted.current) setSending(false)
    }
  }

  const editUserMessage = async (messageId: string): Promise<void> => {
    const conversation = currentConversation
    if (sending || !conversation || !selectedModelId) return
    const index = conversation.messages.findIndex((message) => message.id === messageId)
    const message = conversation.messages[index]
    const trailing = conversation.messages.slice(index + 1)
    if (!message || message.role !== 'user' || trailing.length > 1 || trailing.some((item) => item.role !== 'assistant')) return
    const value = await requestText({ title: 'Edit Work message', label: 'Message', value: message.content, confirmLabel: 'Save & retry' })
    if (!value?.trim() || value.trim() === message.content.trim()) return
    setSending(true)
    setError(undefined)
    try {
      await window.omnicode.work.conversations.updateMessage(conversation.id, messageId, { content: value.trim(), status: 'complete' })
      let updated = await window.omnicode.work.conversations.get(conversation.id)
      let assistant = updated.messages[index + 1]
      if (assistant?.role === 'assistant') {
        await window.omnicode.work.conversations.updateMessage(updated.id, assistant.id, { content: '', status: 'pending', toolActivities: [] })
      } else {
        assistant = await window.omnicode.work.conversations.addMessage(updated.id, { role: 'assistant', content: '', status: 'pending' })
      }
      updated = await window.omnicode.work.conversations.get(updated.id)
      setCurrentConversation(updated)
      await refreshConversationList('')
      const requestMessages = updated.messages.slice(0, index + 1).map((item) => ({
        role: item.role,
        content: item.content,
        attachmentIds: item.attachments?.map((attachment) => attachment.id)
      }))
      await requestAssistantResponse(updated, assistant.id, requestMessages)
    } catch (cause) {
      setError(humanizeWorkError(cause))
    } finally {
      if (mounted.current) setSending(false)
    }
  }

  const copyMessage = async (message: WorkMessage): Promise<void> => {
    try {
      await window.omnicode.app.copyText(message.content)
    } catch (cause) {
      onError(cause)
    }
  }

  const selectAttachments = async (): Promise<void> => {
    try {
      const capacity = Math.max(0, 20 - pendingAttachments.length)
      if (!capacity) return
      const selected = await window.omnicode.work.attachments.select()
      const accepted = selected.slice(0, capacity)
      await Promise.all(selected.slice(capacity).map((attachment) => window.omnicode.work.attachments.remove(attachment.id)))
      setPendingAttachments((current) => [...current, ...accepted]
        .filter((attachment, index, list) => list.findIndex((item) => item.id === attachment.id) === index)
        .slice(0, 20))
    } catch (cause) {
      onError(cause)
    }
  }

  const importDroppedAttachments = async (files: File[]): Promise<void> => {
    const imported: WorkAttachment[] = []
    try {
      for (const file of files.slice(0, 20 - pendingAttachments.length)) {
        imported.push(await window.omnicode.work.attachments.importDroppedFile(file))
      }
      setPendingAttachments((current) => [...current, ...imported].slice(0, 20))
    } catch (cause) {
      await Promise.all(imported.map((attachment) => window.omnicode.work.attachments.remove(attachment.id).catch(() => undefined)))
      onError(cause)
    }
  }

  const removePendingAttachment = async (id: string): Promise<void> => {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id))
    try {
      await window.omnicode.work.attachments.remove(id)
    } catch (cause) {
      onError(cause)
    }
  }

  const stopGeneration = async (): Promise<void> => {
    const active = activeRequest.current
    if (!active) return
    cancelRequested.current.add(active.requestId)
    try {
      await window.omnicode.work.agent.cancel(active.requestId)
    } catch (cause) {
      onError(cause)
    }
  }

  const toggleConnector = async (connector: ConnectorDescriptor): Promise<void> => {
    setConnectorBusyId(connector.id)
    try {
      if (connector.status.state === 'connected') await window.omnicode.work.connectors.disconnect(connector.id)
      else await window.omnicode.work.connectors.connect(connector.id)
      await refreshConnectors(true)
    } catch (cause) { onError(cause) } finally { setConnectorBusyId(null) }
  }

  const openManagedBrowser = async (): Promise<void> => {
    const url = await requestText({ title: 'Open in Managed Browser', label: 'Secure HTTPS address', value: 'https://', confirmLabel: 'Open' })
    if (!url) return
    try {
      await window.omnicode.work.tools.execute({ toolId: 'browser.open', mode: 'work', input: { url } })
    } catch (cause) { onError(cause) }
  }

  const connectedApps = useMemo(() => connectorSummaries(connectors), [connectors])

  return <>
    <WorkModeShell
      conversations={conversations}
      currentConversation={currentConversation}
      searchQuery={searchQuery}
      composerValue={composerValue}
      selectedProvider={selectedProvider}
      selectedModelId={selectedModelId}
      modelCatalog={modelCatalog}
      connectedApps={connectedApps}
      pendingAttachments={pendingAttachments}
      sending={sending}
      modelsLoading={modelsLoading}
      modelsStale={modelState?.stale}
      modelError={modelError}
      error={error}
      onSearchChange={setSearchQuery}
      onComposerChange={setComposerValue}
      onCreateConversation={() => void createConversation()}
      onSelectConversation={(id) => void selectConversation(id)}
      onRenameConversation={(id) => void renameConversation(id)}
      onDeleteConversation={(id) => void deleteConversation(id)}
      onTogglePin={(id, pinned) => void togglePin(id, pinned)}
      onSend={send}
      onStop={() => void stopGeneration()}
      onSelectAttachments={() => void selectAttachments()}
      onDropAttachments={(files) => void importDroppedAttachments(files)}
      onRemoveAttachment={(id) => void removePendingAttachment(id)}
      onCopyMessage={(message) => void copyMessage(message)}
      onEditMessage={(id) => void editUserMessage(id)}
      onRegenerateMessage={(id) => void regenerateMessage(id)}
      onProviderChange={(provider) => void changeProvider(provider)}
      onModelChange={(model) => void changeModel(model)}
      onRefreshModels={(provider) => refreshModels(provider, true).then(() => undefined)}
      onOpenSettings={onOpenSettings}
      onOpenConnectedApps={() => setShowConnectedApps(true)}
      onOpenConnectedApp={() => setShowConnectedApps(true)}
      onLinkError={(message) => onError(new Error(message))}
    />
    {showConnectedApps && <ConnectedAppsDialog connectors={connectors} busyId={connectorBusyId} onClose={() => setShowConnectedApps(false)} onToggle={(connector) => void toggleConnector(connector)} onOpenBrowser={() => void openManagedBrowser()} onManageGoogle={() => void window.omnicode.app.openExternal('https://myaccount.google.com/connections').catch(onError)} />}
  </>
}
