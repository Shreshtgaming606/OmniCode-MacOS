import { useMemo } from 'react'
import {
  Bot,
  CheckCircle2,
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  Copy,
  Cpu,
  FileText,
  FolderClosed,
  Globe2,
  History,
  LoaderCircle,
  MessageSquareText,
  Mail,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Shield,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  X
} from 'lucide-react'

import type { AIProviderId, ProviderDataPolicy } from '../../../../shared/contracts'
import type { WorkApprovalMode } from '../../../../shared/tool-contracts'
import type { AIModelDescriptor } from '../../../../shared/model-contracts'
import { assessModelForUseCase } from '../../../../shared/model-contracts'
import type {
  WorkConversation,
  WorkConversationSummary,
  WorkAttachment,
  WorkMessage,
  WorkToolPreview
} from '../../../../shared/work-contracts'
import { MarkdownMessage } from '../MarkdownMessage'
import { WORK_APPROVAL_MODES, WORK_APPROVAL_MODE_COPY } from '../../lib/work-approval-mode'
import './WorkModeShell.css'

export type WorkConnectedAppState =
  | 'not-connected'
  | 'connecting'
  | 'connected'
  | 'authentication-expired'
  | 'permission-missing'
  | 'network-error'
  | 'rate-limited'
  | 'service-unavailable'

export interface WorkConnectedAppSummary {
  id: string
  name: string
  state: WorkConnectedAppState
  capabilities?: string[]
  detail?: string
}

export interface WorkModeShellProps {
  conversations: WorkConversationSummary[]
  currentConversation: WorkConversation | null
  searchQuery: string
  composerValue: string
  selectedProvider: AIProviderId
  selectedModelId: string
  modelCatalog: AIModelDescriptor[]
  connectedApps: WorkConnectedAppSummary[]
  pendingAttachments: WorkAttachment[]
  sending?: boolean
  modelsLoading?: boolean
  modelsStale?: boolean
  modelError?: string
  providerPolicy?: ProviderDataPolicy | null
  error?: string
  approvalMode: WorkApprovalMode
  onSearchChange(value: string): void
  onComposerChange(value: string): void
  onCreateConversation(): void
  onSelectConversation(id: string): void
  onRenameConversation(id: string): void
  onDeleteConversation(id: string): void
  onTogglePin(id: string, pinned: boolean): void
  onSend(message: string): void | Promise<void>
  onStop(): void
  onSelectAttachments(): void
  onDropAttachments(files: File[]): void
  onRemoveAttachment(id: string): void
  onCopyMessage(message: WorkMessage): void
  onEditMessage(messageId: string): void
  onRegenerateMessage(messageId: string): void
  onProviderChange(provider: AIProviderId): void
  onModelChange(modelId: string): void
  onRefreshModels(provider: AIProviderId): void | Promise<void>
  onOpenSettings(): void
  onOpenConnectedApps(): void
  onOpenConnectedApp(id: string): void
  onApprovalModeChange(mode: WorkApprovalMode): void
  onOpenActivity(): void
  onLinkError(message: string): void
}

const PROVIDER_NAMES: Record<AIProviderId, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google'
}

const PROVIDERS: readonly AIProviderId[] = ['ollama', 'openai', 'anthropic', 'google']

const GENERAL_SUGGESTIONS = [
  'Create a focused action plan',
  'Summarize an attached document',
  'Draft a clear project brief',
  'Help me think through a decision'
] as const

const CONNECTOR_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  browser: [
    'Research a topic using the connected browser',
    'Compare current information from several sources'
  ],
  gmail: [
    'Summarize my unread Gmail messages',
    'Draft a reply to a recent email'
  ],
  'google-drive': [
    'Find a document in Google Drive',
    'Summarize a file from Google Drive'
  ]
}

function dateValue(value: string | number): number {
  return typeof value === 'number' ? value : Date.parse(value)
}

function relativeTime(value: string | number): string {
  const elapsed = Date.now() - dateValue(value)
  if (!Number.isFinite(elapsed)) return ''
  if (elapsed < 60_000) return 'Now'
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`
  return new Date(dateValue(value)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function connectionLabel(state: WorkConnectedAppState): string {
  switch (state) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting…'
    case 'authentication-expired': return 'Reconnect required'
    case 'permission-missing': return 'Permission required'
    case 'network-error': return 'Network error'
    case 'rate-limited': return 'Rate limited'
    case 'service-unavailable': return 'Unavailable'
    default: return 'Not connected'
  }
}

function conversationGroups(conversations: WorkConversationSummary[]): Array<{
  label: string
  items: WorkConversationSummary[]
}> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStart = today.getTime()
  const previousWeekStart = todayStart - (6 * 86_400_000)
  return [
    { label: 'Today', items: conversations.filter((conversation) => dateValue(conversation.updatedAt) >= todayStart) },
    {
      label: 'Previous 7 days',
      items: conversations.filter((conversation) => {
        const updatedAt = dateValue(conversation.updatedAt)
        return updatedAt >= previousWeekStart && updatedAt < todayStart
      })
    },
    { label: 'Older', items: conversations.filter((conversation) => dateValue(conversation.updatedAt) < previousWeekStart) }
  ]
}

export function suggestionsForConnectedApps(connectedApps: WorkConnectedAppSummary[]): string[] {
  const connected = connectedApps.filter((app) => app.state === 'connected')
  const ids = new Set(connected.map((app) => app.id))
  const connectedSuggestions = connected
    .flatMap((app) => CONNECTOR_SUGGESTIONS[app.id] ?? [])
  const crossConnector = ids.has('gmail') && ids.has('google-drive')
    ? ['Find an email attachment and save it to Drive']
    : []
  return [...new Set([...crossConnector, ...connectedSuggestions, ...GENERAL_SUGGESTIONS])].slice(0, 4)
}

function ConversationList({
  label,
  items,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  onTogglePin
}: {
  label: string
  items: WorkConversationSummary[]
  selectedId?: string
  onSelect(id: string): void
  onRename(id: string): void
  onDelete(id: string): void
  onTogglePin(id: string, pinned: boolean): void
}) {
  if (!items.length) return null
  return <section className="work-conversation-section" aria-label={label}>
    <h2>{label}</h2>
    <div className="work-conversation-list">
      {items.map((conversation) => <div
        className={`work-conversation-row${selectedId === conversation.id ? ' active' : ''}`}
        key={conversation.id}
      >
        <button
          type="button"
          className="work-conversation-open"
          aria-current={selectedId === conversation.id ? 'page' : undefined}
          onClick={() => onSelect(conversation.id)}
        >
          <MessageSquareText />
          <span><strong>{conversation.title}</strong><small>{relativeTime(conversation.updatedAt)}</small></span>
        </button>
        <div className="work-conversation-actions">
          <button type="button" title={conversation.pinned ? 'Unpin chat' : 'Pin chat'} aria-label={`${conversation.pinned ? 'Unpin' : 'Pin'} ${conversation.title}`} onClick={() => onTogglePin(conversation.id, !conversation.pinned)}>{conversation.pinned ? <PinOff /> : <Pin />}</button>
          <button type="button" title="Rename chat" aria-label={`Rename ${conversation.title}`} onClick={() => onRename(conversation.id)}><Pencil /></button>
          <button type="button" className="danger" title="Delete chat" aria-label={`Delete ${conversation.title}`} onClick={() => onDelete(conversation.id)}><Trash2 /></button>
        </div>
      </div>)}
    </div>
  </section>
}

function WorkResultPreview({ preview }: { preview: WorkToolPreview }) {
  const gmail = preview.kind.startsWith('gmail')
  const drive = preview.kind === 'drive-files' || preview.kind === 'drive-file'
  return <section className={`work-result-preview kind-${preview.kind}`} aria-label={preview.label}>
    <header>
      {gmail ? <Mail /> : drive ? <FolderClosed /> : <FileText />}
      <strong>{preview.label}</strong>
      {preview.count !== undefined && <small>{preview.count}{preview.truncated ? '+' : ''}</small>}
    </header>
    <div>{preview.items.map((item, index) => <article key={`${item.title}-${index}`}>
      <span>{gmail ? <Mail /> : <FileText />}</span>
      <div><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}{item.detail && <p>{item.detail}</p>}{item.metadata && <time>{item.metadata}</time>}</div>
    </article>)}</div>
  </section>
}

function WorkMessageView({
  message,
  canEdit,
  canRegenerate,
  onCopy,
  onEdit,
  onRegenerate,
  onLinkError
}: {
  message: WorkMessage
  canEdit: boolean
  canRegenerate: boolean
  onCopy(message: WorkMessage): void
  onEdit(messageId: string): void
  onRegenerate(messageId: string): void
  onLinkError(message: string): void
}) {
  const user = message.role === 'user'
  return <article className={`work-message ${user ? 'user' : 'assistant'} status-${message.status ?? 'complete'}`}>
    <span className="work-message-avatar">{user ? <UserRound /> : <Bot />}</span>
    <div className="work-message-content">
      <strong>{user ? 'You' : 'OmniCode'}</strong>
      {user
        ? <p className="work-message-plain">{message.content}</p>
        : <MarkdownMessage content={message.content} onLinkError={onLinkError} />}
      {!!message.attachments?.length && <div className="work-message-attachments" aria-label="Message attachments">{message.attachments.map((attachment) => <span key={attachment.id}><FileText />{attachment.name}</span>)}</div>}
      {!!message.toolActivities?.length && <div className="work-tool-activities" aria-label="Connected app activity">
        {message.toolActivities.map((activity) => <div className={`work-tool-activity state-${activity.status}`} key={activity.id}>
          {activity.status === 'succeeded' ? <CheckCircle2 /> : activity.status === 'failed' ? <CircleAlert /> : <LoaderCircle className={activity.status === 'running' ? 'spin' : ''} />}
          <div><strong>{activity.name}</strong><small>{activity.summary ?? activity.status}</small>
            {activity.preview && <WorkResultPreview preview={activity.preview} />}
          </div>
        </div>)}
      </div>}
      <div className="work-message-actions">
        {!user && message.content && <button type="button" aria-label="Copy response" title="Copy response" onClick={() => onCopy(message)}><Copy />Copy</button>}
        {user && canEdit && <button type="button" aria-label="Edit message" title="Edit message" onClick={() => onEdit(message.id)}><Pencil />Edit</button>}
        {!user && canRegenerate && <button type="button" aria-label={message.status === 'failed' ? 'Retry response' : 'Regenerate response'} title={message.status === 'failed' ? 'Retry response' : 'Regenerate response'} onClick={() => onRegenerate(message.id)}><RotateCcw />{message.status === 'failed' ? 'Retry' : 'Regenerate'}</button>}
      </div>
    </div>
  </article>
}

export function WorkModeShell({
  conversations,
  currentConversation,
  searchQuery,
  composerValue,
  selectedProvider,
  selectedModelId,
  modelCatalog,
  connectedApps,
  pendingAttachments,
  sending = false,
  modelsLoading = false,
  modelsStale = false,
  modelError,
  providerPolicy,
  error,
  approvalMode,
  onSearchChange,
  onComposerChange,
  onCreateConversation,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onTogglePin,
  onSend,
  onStop,
  onSelectAttachments,
  onDropAttachments,
  onRemoveAttachment,
  onCopyMessage,
  onEditMessage,
  onRegenerateMessage,
  onProviderChange,
  onModelChange,
  onRefreshModels,
  onOpenSettings,
  onOpenConnectedApps,
  onOpenConnectedApp,
  onApprovalModeChange,
  onOpenActivity,
  onLinkError
}: WorkModeShellProps) {
  const pinned = useMemo(() => conversations.filter((conversation) => conversation.pinned), [conversations])
  const recent = useMemo(() => conversations.filter((conversation) => !conversation.pinned), [conversations])
  const historyGroups = useMemo(
    () => searchQuery.trim()
      ? [{ label: 'Results', items: recent }]
      : conversationGroups(recent),
    [recent, searchQuery]
  )
  const suggestions = useMemo(() => suggestionsForConnectedApps(
    providerPolicy?.allowsGoogleWorkspaceData === false
      ? connectedApps.filter((app) => app.id !== 'gmail' && app.id !== 'google-drive')
      : connectedApps
  ), [connectedApps, providerPolicy?.allowsGoogleWorkspaceData])
  const models = useMemo(() => modelCatalog.filter((model) => model.provider === selectedProvider), [modelCatalog, selectedProvider])
  const selectedModel = modelCatalog.find((model) => model.provider === selectedProvider && model.id === selectedModelId)
  const local = selectedModel?.local ?? selectedProvider === 'ollama'
  const toolAssessment = selectedModel ? assessModelForUseCase(selectedModel, 'work-tools') : undefined
  const connectedToolsPresent = connectedApps.some((app) => app.state === 'connected')
  const capabilityLabels = selectedModel
    ? ([['chat', 'Chat'], ['tool-calling', 'Tools'], ['vision', 'Vision'], ['coding', 'Coding']] as const)
      .filter(([capability]) => selectedModel.capabilities[capability].support === 'supported')
      .map(([, label]) => label)
    : []
  const latestAssistantId = [...(currentConversation?.messages ?? [])].reverse().find((message) => message.role === 'assistant')?.id
  const latestUserId = [...(currentConversation?.messages ?? [])].reverse().find((message) => message.role === 'user')?.id

  const submit = (): void => {
    const message = composerValue.trim()
    if (!message || sending || !selectedModelId) return
    void onSend(message)
  }

  return <div className="work-mode-shell">
    <aside className="work-sidebar" aria-label="Work Mode navigation">
      <header className="work-sidebar-header">
        <div><Sparkles /><span><strong>Work Mode</strong><small>Conversations and connected apps</small></span></div>
      </header>
      <button type="button" className="work-new-chat" onClick={onCreateConversation}><Plus />New chat</button>
      <label className="work-chat-search"><Search /><input aria-label="Search chats" value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search chats" /></label>
      <div className="work-history">
        {!conversations.length && <div className="work-history-empty"><MessageSquareText /><p>Your conversations will appear here.</p></div>}
        <ConversationList label="Pinned" items={pinned} selectedId={currentConversation?.id} onSelect={onSelectConversation} onRename={onRenameConversation} onDelete={onDeleteConversation} onTogglePin={onTogglePin} />
        {historyGroups.map((group) => <ConversationList label={group.label} items={group.items} selectedId={currentConversation?.id} onSelect={onSelectConversation} onRename={onRenameConversation} onDelete={onDeleteConversation} onTogglePin={onTogglePin} key={group.label} />)}
      </div>
      <section className="work-connected-apps" aria-label="Connected Apps">
        <header><div><Plug /><strong>Connected Apps</strong></div><button type="button" onClick={onOpenConnectedApps}>Manage</button></header>
        {connectedApps.length
          ? connectedApps.map((app) => {
            const AppIcon = app.id === 'gmail' ? Mail : app.id === 'google-drive' ? FolderClosed : app.id === 'browser' ? Globe2 : Plug
            return <button type="button" className={`work-app-row state-${app.state}`} key={app.id} onClick={() => onOpenConnectedApp(app.id)}>
            <span className="work-app-icon">{app.state === 'connecting' ? <LoaderCircle className="spin" /> : <AppIcon />}</span>
            <span><strong>{app.name}</strong><small>{app.detail ?? connectionLabel(app.state)}</small></span>
          </button>})
          : <button type="button" className="work-app-empty" onClick={onOpenConnectedApps}>No apps configured</button>}
      </section>
      <div className="work-sidebar-footer"><button type="button" className="work-settings-link" onClick={onOpenActivity}><History />Activity</button><button type="button" className="work-settings-link" onClick={onOpenSettings}><Settings />Settings</button></div>
    </aside>

    <main className="work-chat-main">
      <header className="work-chat-header">
        <div className="work-chat-heading"><strong>{currentConversation?.title ?? 'New conversation'}</strong><small>{currentConversation ? 'Work Mode conversation' : 'Ask anything or start with a suggestion'}</small></div>
        <div className="work-model-controls">
          <details className={`work-approval-selector mode-${approvalMode}`}>
            <summary aria-label={`Work action approvals: ${WORK_APPROVAL_MODE_COPY[approvalMode].label}`}><Shield /><span><small>Approval</small><strong>{WORK_APPROVAL_MODE_COPY[approvalMode].shortLabel}</strong></span><ChevronDown /></summary>
            <div>{WORK_APPROVAL_MODES.map((mode) => <button type="button" className={mode === approvalMode ? 'active' : ''} key={mode} onClick={(event) => {
              onApprovalModeChange(mode)
              event.currentTarget.closest('details')?.removeAttribute('open')
            }}><span><strong>{WORK_APPROVAL_MODE_COPY[mode].label}</strong><small>{WORK_APPROVAL_MODE_COPY[mode].description}</small></span>{mode === approvalMode && <Check />}</button>)}</div>
          </details>
          <label><span>Provider</span><select aria-label="Work AI provider" value={selectedProvider} onChange={(event) => onProviderChange(event.target.value as AIProviderId)}>{PROVIDERS.map((provider) => <option value={provider} key={provider}>{PROVIDER_NAMES[provider]}</option>)}</select></label>
          <label><span>Model</span><select aria-label="Work AI model" value={selectedModelId} disabled={modelsLoading || !models.length} onChange={(event) => onModelChange(event.target.value)}>
            {!models.length && <option value="">No available models</option>}
            {models.map((model) => <option key={`${model.provider}:${model.id}`} value={model.id} disabled={model.availability === 'unavailable' || model.capabilities.chat.support === 'unsupported'}>{model.displayName}{model.availability === 'unavailable' ? ' — unavailable' : model.capabilities.chat.support === 'unsupported' ? ' — not compatible with chat' : ''}</option>)}
          </select></label>
          <button type="button" className="work-model-refresh" disabled={modelsLoading} title="Refresh models" aria-label={`Refresh ${PROVIDER_NAMES[selectedProvider]} models`} onClick={() => void onRefreshModels(selectedProvider)}>{modelsLoading ? <LoaderCircle className="spin" /> : <RefreshCw />}</button>
        </div>
      </header>

      <div className="work-model-status" role={modelError ? 'alert' : 'status'}>
        {!selectedModel
          ? <><CircleAlert /><span>Choose an available model to start a Work conversation.</span></>
          : providerPolicy?.allowsGoogleWorkspaceData === false
            ? <><CircleAlert /><span><strong>Google Workspace blocked</strong> — Gmail and Drive content will not be sent to {providerPolicy.displayName}. Choose a local Ollama model, OpenAI, or Anthropic for those tools.</span></>
          : local
            ? <><Cpu /><span><strong>Local AI</strong> — relevant Gmail or Drive content can be processed on this Mac. Google API requests still use the network.</span></>
            : <><Cloud /><span><strong>Cloud AI: {PROVIDER_NAMES[selectedProvider]}</strong> — when needed for your request, the minimum relevant Gmail or Drive content will be sent to this provider.</span></>}
        {capabilityLabels.length > 0 && <span className="work-capability-labels">{capabilityLabels.map((label) => <small key={label}>{label}</small>)}</span>}
        {connectedToolsPresent && toolAssessment?.support === 'chat-only' && <em className="warning">Chat only — connected-app tools are disabled for this model.</em>}
        {modelsStale && <em>Using cached model information</em>}
        {modelError && <em className="error">{modelError}</em>}
      </div>

      <div className="work-chat-scroll" aria-live="polite">
        {currentConversation?.messages.length
          ? <div className="work-message-list">{currentConversation.messages.map((message) => <WorkMessageView
            message={message}
            canEdit={!sending && message.id === latestUserId}
            canRegenerate={!sending && message.id === latestAssistantId}
            onCopy={onCopyMessage}
            onEdit={onEditMessage}
            onRegenerate={onRegenerateMessage}
            onLinkError={onLinkError}
            key={message.id}
          />)}{sending && <div className="work-thinking"><span /><span /><span />Working with {selectedModel?.displayName ?? selectedModelId}…</div>}</div>
          : <div className="work-empty-state"><div className="work-empty-mark"><Sparkles /></div><h1>What can OmniCode help with?</h1><p>Start a focused conversation for research, writing, planning, or work with services you choose to connect.</p><div>{suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => onComposerChange(suggestion)}>{suggestion}</button>)}</div></div>}
      </div>

      <div className="work-composer-wrap">
        {error && <div className="work-chat-error" role="alert"><strong>Request failed</strong><span>{error}</span></div>}
        <form className="work-composer" onSubmit={(event) => { event.preventDefault(); submit() }} onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }} onDrop={(event) => {
          const files = [...event.dataTransfer.files]
          if (!files.length) return
          event.preventDefault()
          onDropAttachments(files)
        }}>
          {!!pendingAttachments.length && <div className="work-pending-attachments" aria-label="Pending attachments">{pendingAttachments.map((attachment) => <span key={attachment.id}><FileText /><strong>{attachment.name}</strong><small>{attachment.sizeBytes === undefined ? '' : `${Math.max(1, Math.ceil(attachment.sizeBytes / 1024))} KB`}</small><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemoveAttachment(attachment.id)}><X /></button></span>)}</div>}
          <textarea aria-label="Message OmniCode Work" rows={3} value={composerValue} onChange={(event) => onComposerChange(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
          }} placeholder="Ask OmniCode to help with your work…" />
          <footer><button type="button" className="work-attach" title="Attach files from this Mac" aria-label="Attach files" disabled={sending || pendingAttachments.length >= 20} onClick={onSelectAttachments}><Paperclip /></button><span>{selectedModel?.displayName ?? (modelsLoading ? 'Loading models…' : 'Choose a model')}</span>{sending
            ? <button type="button" className="work-stop" title="Stop generation" aria-label="Stop Work generation" onClick={onStop}><Square /></button>
            : <button type="submit" className="work-send" title="Send message" aria-label="Send Work message" disabled={!composerValue.trim() || !selectedModelId}><Send /></button>}</footer>
        </form>
      </div>
    </main>
  </div>
}
