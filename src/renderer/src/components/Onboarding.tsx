import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Code2,
  Cpu,
  Download,
  FolderOpen,
  GitFork,
  HardDrive,
  KeyRound,
  Laptop,
  LoaderCircle,
  Moon,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sun,
  Wrench,
  X,
  type LucideIcon
} from 'lucide-react'

import type { AIModel, OllamaPullProgress, ToolInstallationProgress } from '../../../shared/contracts'

import './Onboarding.css'

export type AppearanceSelection = 'system' | 'light' | 'dark'

export type DetectedToolStatus = 'available' | 'missing' | 'checking'

export type DetectedToolCategory = 'development' | 'runtime'

export interface DetectedTool {
  id: string
  name: string
  status: DetectedToolStatus
  version?: string
  path?: string
  hint?: string
  category?: DetectedToolCategory
  installable?: boolean
}

export type OllamaStatus = 'ready' | 'not-installed' | 'unavailable' | 'checking' | 'error'

export interface OllamaState {
  status: OllamaStatus
  version?: string
  models?: string[]
  hint?: string
}

export interface OnboardingProps {
  detectedTools: DetectedTool[]
  ollama: OllamaState
  appearance: AppearanceSelection
  onAppearanceChange: (appearance: AppearanceSelection) => void
  onComplete: () => void | Promise<void>
  onOpenFolder: () => void | Promise<void>
  onCloneRepository: () => void | Promise<void>
  onCreateProject: () => void | Promise<void>
  onSaveProvider: (provider: 'openai' | 'anthropic' | 'google', apiKey: string) => Promise<void>
  toolInstallations: Record<string, ToolInstallationProgress>
  modelCatalog: AIModel[]
  modelPulls: Record<string, OllamaPullProgress>
  onInstallTool: (toolId: string) => Promise<void>
  onCancelToolInstallation: (toolId: string) => Promise<void>
  onRefreshSetup: () => Promise<void>
  onPullModel: (model: string) => Promise<void>
  onCancelModelPull: (model: string) => Promise<void>
}

interface StepDefinition {
  title: string
  shortTitle: string
  description: string
  icon: LucideIcon
}

const STEPS: StepDefinition[] = [
  {
    title: 'Make OmniCode yours',
    shortTitle: 'Appearance',
    description: 'Choose how OmniCode should look. You can change this at any time.',
    icon: Sun
  },
  {
    title: 'Development tools',
    shortTitle: 'Dev tools',
    description: 'Check your Mac and install the development tools your projects need.',
    icon: Wrench
  },
  {
    title: 'Programming runtimes',
    shortTitle: 'Runtimes',
    description: 'Use your existing runtimes or download and install the ones you need here.',
    icon: Code2
  },
  {
    title: 'Local AI with Ollama',
    shortTitle: 'Local AI',
    description: 'Run coding models on this Mac without sending project context to a cloud provider.',
    icon: Cpu
  },
  {
    title: 'Cloud AI providers',
    shortTitle: 'Cloud AI',
    description: 'Cloud AI is optional and can be configured securely later in Settings.',
    icon: Cloud
  },
  {
    title: 'Ready to build',
    shortTitle: 'Workspace',
    description: 'Open a folder now, or finish setup and choose a project later.',
    icon: FolderOpen
  }
]

const APPEARANCE_OPTIONS: Array<{
  value: AppearanceSelection
  label: string
  detail: string
  icon: LucideIcon
}> = [
  {
    value: 'system',
    label: 'System',
    detail: 'Match macOS automatically',
    icon: Laptop
  },
  {
    value: 'dark',
    label: 'Dark',
    detail: 'A low-glare editor palette',
    icon: Moon
  },
  {
    value: 'light',
    label: 'Light',
    detail: 'A crisp, bright workspace',
    icon: Sun
  }
]

const DEVELOPMENT_TOOL_IDS = new Set([
  'xcode',
  'xcode-clt',
  'xcode-command-line-tools',
  'command-line-tools',
  'git',
  'homebrew',
  'brew'
])

function normalizedToolId(tool: DetectedTool): string {
  return tool.id.trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
}

function isDevelopmentTool(tool: DetectedTool): boolean {
  if (tool.category) return tool.category === 'development'

  const id = normalizedToolId(tool)
  const name = tool.name.toLowerCase()
  return (
    DEVELOPMENT_TOOL_IDS.has(id) ||
    name.includes('xcode') ||
    name === 'git' ||
    name.includes('homebrew')
  )
}

function StepStatusIcon({ status }: { status: DetectedToolStatus }): ReactNode {
  if (status === 'checking') {
    return <LoaderCircle className="onboarding__spin" aria-hidden="true" />
  }

  if (status === 'available') {
    return <CheckCircle2 aria-hidden="true" />
  }

  return <CircleAlert aria-hidden="true" />
}

function statusLabel(status: DetectedToolStatus): string {
  if (status === 'checking') return 'Checking'
  if (status === 'available') return 'Detected'
  return 'Not found'
}

interface SetupActions {
  pending: Record<string, boolean>
  errors: Record<string, string>
  run: (key: string, action: () => Promise<void>) => void
}

function InstallationProgress({ progress }: { progress: ToolInstallationProgress }): ReactNode {
  const active = !progress.done
  return (
    <div className={`onboarding__installation onboarding__installation--${progress.phase}`} aria-live="polite">
      <span className="onboarding__progress-label">
        {active ? <LoaderCircle className="onboarding__spin" aria-hidden="true" /> : progress.phase === 'completed' ? <CheckCircle2 aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
        <span>{progress.message}</span>
        {active && progress.percent !== undefined ? <strong>{Math.round(progress.percent)}%</strong> : null}
      </span>
      {active ? <progress aria-label="Installation progress" max={100} value={progress.percent} /> : null}
      {progress.detail ? <p>{progress.detail}</p> : null}
      {progress.error ? <p role="alert">{progress.error}</p> : null}
      {progress.phase === 'waiting-for-user' ? <p>Complete the macOS installer, then select Refresh to check the result. If a prerequisite was installed, select Install again to continue.</p> : null}
    </div>
  )
}

function RefreshSetup({ actions, onRefreshSetup }: { actions: SetupActions; onRefreshSetup: () => Promise<void> }): ReactNode {
  return <div className="onboarding__setup-toolbar">
    <span>Only install what you need. You can continue while downloads run.</span>
    <button className="onboarding__button onboarding__button--secondary onboarding__button--compact" type="button" disabled={actions.pending.refresh} onClick={() => actions.run('refresh', onRefreshSetup)}>
      <RefreshCw className={actions.pending.refresh ? 'onboarding__spin' : ''} aria-hidden="true" />
      {actions.pending.refresh ? 'Checking…' : 'Refresh'}
    </button>
    {actions.errors.refresh ? <div className="onboarding__provider-error" role="alert">{actions.errors.refresh}</div> : null}
  </div>
}

function ToolList({ tools, emptyMessage, toolInstallations, onInstallTool, onCancelToolInstallation, onRefreshSetup, actions, toolInstallBusy }: Pick<OnboardingProps, 'toolInstallations' | 'onInstallTool' | 'onCancelToolInstallation' | 'onRefreshSetup'> & { tools: DetectedTool[]; emptyMessage: string; actions: SetupActions; toolInstallBusy: boolean }): ReactNode {
  if (tools.length === 0) {
    return (
      <div className="onboarding__ai-stack">
      <RefreshSetup actions={actions} onRefreshSetup={onRefreshSetup} />
      <div className="onboarding__empty-state">
        <CircleAlert aria-hidden="true" />
        <div>
          <strong>No detection results yet</strong>
          <p>{emptyMessage}</p>
        </div>
      </div>
      </div>
    )
  }

  return (
    <div className="onboarding__ai-stack">
    <RefreshSetup actions={actions} onRefreshSetup={onRefreshSetup} />
    <ul className="onboarding__tool-list" aria-label="Detection results">
      {tools.map((tool) => {
        const progress = toolInstallations[tool.id]
        const key = `tool:${tool.id}`
        const active = Boolean(actions.pending[key] || (progress && !progress.done))
        const canInstall = tool.installable && tool.status === 'missing'
        return (
        <li className={`onboarding__tool onboarding__tool--${tool.status}`} key={tool.id}>
          <span className="onboarding__tool-icon">
            <StepStatusIcon status={tool.status} />
          </span>
          <span className="onboarding__tool-copy">
            <span className="onboarding__tool-name-row">
              <strong>{tool.name}</strong>
              {tool.version ? <span className="onboarding__tool-version">{tool.version}</span> : null}
            </span>
            {tool.path ? (
              <code className="onboarding__tool-path" title={tool.path}>
                {tool.path}
              </code>
            ) : tool.hint ? (
              <span className="onboarding__tool-hint">{tool.hint}</span>
            ) : (
              <span className="onboarding__tool-hint">
                {tool.status === 'checking'
                  ? 'Detection is still in progress.'
                  : tool.status === 'missing'
                    ? 'You can install this later if your projects require it.'
                    : 'Ready to use.'}
              </span>
            )}
          </span>
          {active ? (
            <button type="button" className="onboarding__button onboarding__button--secondary onboarding__button--compact" disabled={!progress?.cancellable || actions.pending[`cancel:${key}`]} onClick={() => actions.run(`cancel:${key}`, () => onCancelToolInstallation(tool.id))} aria-label={`Cancel ${tool.name} installation`}><X aria-hidden="true" />Cancel</button>
          ) : canInstall ? (
            <button type="button" className="onboarding__button onboarding__button--install" disabled={toolInstallBusy} onClick={() => actions.run(key, () => onInstallTool(tool.id))} aria-label={`Install ${tool.name}`}><Download aria-hidden="true" />{progress?.phase === 'failed' || progress?.phase === 'cancelled' ? 'Retry' : 'Install'}</button>
          ) : <span className={`onboarding__status onboarding__status--${tool.status}`}>
            {statusLabel(tool.status)}
          </span>}
          {progress && (tool.status !== 'available' || active) ? <InstallationProgress progress={progress} /> : active ? <div className="onboarding__installation" role="status"><LoaderCircle className="onboarding__spin" aria-hidden="true" /> Preparing installer…</div> : null}
          {actions.errors[key] || actions.errors[`cancel:${key}`] ? <div className="onboarding__provider-error onboarding__row-error" role="alert">{actions.errors[key] || actions.errors[`cancel:${key}`]}</div> : null}
        </li>
      )})}
    </ul>
    </div>
  )
}

function AppearancePreview({ appearance }: { appearance: AppearanceSelection }): ReactNode {
  return (
    <span
      className={`onboarding__appearance-preview onboarding__appearance-preview--${appearance}`}
      aria-hidden="true"
    >
      <span className="onboarding__preview-rail" />
      <span className="onboarding__preview-sidebar">
        <span />
        <span />
        <span />
      </span>
      <span className="onboarding__preview-editor">
        <span />
        <span />
        <span />
        <span />
      </span>
    </span>
  )
}

function AppearanceStep({
  appearance,
  onAppearanceChange
}: Pick<OnboardingProps, 'appearance' | 'onAppearanceChange'>): ReactNode {
  return (
    <fieldset className="onboarding__appearance-fieldset">
      <legend className="onboarding__sr-only">Choose an appearance</legend>
      <div className="onboarding__appearance-grid">
        {APPEARANCE_OPTIONS.map((option) => {
          const Icon = option.icon
          const selected = appearance === option.value

          return (
            <label
              className={`onboarding__appearance-option${selected ? ' is-selected' : ''}`}
              key={option.value}
            >
              <input
                checked={selected}
                name="omnicode-appearance"
                onChange={() => onAppearanceChange(option.value)}
                type="radio"
                value={option.value}
              />
              <AppearancePreview appearance={option.value} />
              <span className="onboarding__appearance-label-row">
                <span className="onboarding__appearance-icon">
                  <Icon aria-hidden="true" />
                </span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
                <span className="onboarding__appearance-check" aria-hidden="true">
                  {selected ? <Check /> : null}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      <p className="onboarding__supporting-copy">
        System follows your Mac's appearance. Editor themes and syntax colors can be customized separately.
      </p>
    </fieldset>
  )
}

function formatDownloadSize(bytes?: number): string {
  if (bytes === undefined) return 'Size varies'
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

function LocalAiStep({ ollama, toolInstallations, modelCatalog, modelPulls, onInstallTool, onCancelToolInstallation, onRefreshSetup, onPullModel, onCancelModelPull, actions, toolInstallBusy }: Pick<OnboardingProps, 'ollama' | 'toolInstallations' | 'modelCatalog' | 'modelPulls' | 'onInstallTool' | 'onCancelToolInstallation' | 'onRefreshSetup' | 'onPullModel' | 'onCancelModelPull'> & { actions: SetupActions; toolInstallBusy: boolean }): ReactNode {
  const isReady = ollama.status === 'ready'
  const isChecking = ollama.status === 'checking'
  const installation = toolInstallations.ollama
  const installing = Boolean(actions.pending['tool:ollama'] || (installation && !installation.done))
  const recommendationOrder = ['Recommended', 'Should Run', 'May Run Slowly', 'Not Recommended']
  const rank = (model: AIModel): number => {
    const index = model.recommendation ? recommendationOrder.indexOf(model.recommendation) : -1
    return index < 0 ? 4 : index
  }
  const compareModels = (a: AIModel, b: AIModel): number => {
    return rank(a) - rank(b) || (a.approximateDownloadSize ?? Infinity) - (b.approximateDownloadSize ?? Infinity)
  }
  const sortedCatalog = modelCatalog.filter((model) => model.local && !model.installed).sort(compareModels)
  const featuredIds = new Set(sortedCatalog.slice(0, 4).map((model) => model.id))
  const featuredModels = modelCatalog.filter((model) => featuredIds.has(model.id) || modelPulls[model.id] || actions.pending[`model:${model.id}`]).sort(compareModels)
  const statusText: Record<OllamaStatus, string> = {
    ready: 'Connected',
    'not-installed': 'Not installed',
    unavailable: 'Service unavailable',
    checking: 'Checking',
    error: 'Could not connect'
  }

  return (
    <div className="onboarding__ai-stack">
      <RefreshSetup actions={actions} onRefreshSetup={onRefreshSetup} />
      <section
        className={`onboarding__ollama-card onboarding__ollama-card--${ollama.status}`}
        aria-live="polite"
      >
        <span className="onboarding__ollama-icon">
          {isChecking ? (
            <LoaderCircle className="onboarding__spin" aria-hidden="true" />
          ) : isReady ? (
            <CheckCircle2 aria-hidden="true" />
          ) : (
            <Bot aria-hidden="true" />
          )}
        </span>
        <span className="onboarding__ollama-copy">
          <span className="onboarding__eyebrow">Ollama</span>
          <strong>{statusText[ollama.status]}</strong>
          <span>
            {ollama.hint ??
              (isReady
                ? 'Local model requests stay on this Mac.'
                : isChecking
                  ? 'Testing the local Ollama service.'
                  : 'Install Ollama to download and run local models here.')}
          </span>
        </span>
        <div className="onboarding__ollama-actions">
          {ollama.version ? <span className="onboarding__version-badge">v{ollama.version}</span> : null}
          {installing ? <button type="button" className="onboarding__button onboarding__button--secondary onboarding__button--compact" disabled={!installation?.cancellable || actions.pending['cancel:tool:ollama']} onClick={() => actions.run('cancel:tool:ollama', () => onCancelToolInstallation('ollama'))}><X aria-hidden="true" />Cancel</button> : !isReady ? <button type="button" className="onboarding__button onboarding__button--install" disabled={isChecking || toolInstallBusy} onClick={() => actions.run('tool:ollama', () => onInstallTool('ollama'))}><Download aria-hidden="true" />{ollama.status === 'not-installed' ? 'Install Ollama' : 'Start Ollama'}</button> : null}
        </div>
        {installation && (!isReady || installing) ? <InstallationProgress progress={installation} /> : installing ? <div className="onboarding__installation" role="status">Preparing Ollama…</div> : null}
        {actions.errors['tool:ollama'] || actions.errors['cancel:tool:ollama'] ? <div className="onboarding__provider-error onboarding__row-error" role="alert">{actions.errors['tool:ollama'] || actions.errors['cancel:tool:ollama']}</div> : null}
      </section>

      {isReady && ollama.models && ollama.models.length > 0 ? (
        <section className="onboarding__models" aria-labelledby="onboarding-models-title">
          <div className="onboarding__section-heading">
            <div>
              <span className="onboarding__eyebrow">Available now</span>
              <h3 id="onboarding-models-title">Installed models</h3>
            </div>
            <span>{ollama.models.length}</span>
          </div>
          <ul>
            {ollama.models.slice(0, 6).map((model) => (
              <li key={model}>
                <HardDrive aria-hidden="true" />
                <span>{model}</span>
                <span>Local</span>
              </li>
            ))}
          </ul>
          {ollama.models.length > 6 ? (
            <p className="onboarding__supporting-copy">
              {ollama.models.length - 6} more installed models are available in the Models view.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="onboarding__model-catalog" aria-labelledby="onboarding-download-models-title">
        <div className="onboarding__section-heading">
          <div><span className="onboarding__eyebrow">Choose a coding model</span><h3 id="onboarding-download-models-title">Download local AI</h3></div>
          <HardDrive aria-hidden="true" />
        </div>
        <p className="onboarding__supporting-copy">Recommendations reflect this Mac's memory. Your first downloaded model becomes the default if you have not selected one yet.</p>
        {!isReady ? <p className="onboarding__model-prerequisite">Install or start Ollama above to enable model downloads.</p> : null}
        <div className="onboarding__model-grid">
          {featuredModels.map((model) => {
            const key = `model:${model.id}`
            const progress = modelPulls[model.id]
            const active = Boolean(actions.pending[key] || (progress && !progress.done))
            const installed = model.installed || ollama.models?.includes(model.id) || (progress?.done && !progress.cancelled && !progress.error)
            const failed = progress?.error || actions.errors[key]
            return <article className="onboarding__model-card" key={model.id}>
              <div className="onboarding__model-title"><Cpu aria-hidden="true" /><strong>{model.name}</strong></div>
              <code>{model.id}</code>
              {model.recommendation ? <span className={`onboarding__recommendation onboarding__recommendation--${model.recommendation.toLowerCase().replaceAll(' ', '-')}`}>{model.recommendation}</span> : null}
              {model.description ? <p>{model.description}</p> : null}
              <div className="onboarding__model-facts"><span><Download aria-hidden="true" />~{formatDownloadSize(model.approximateDownloadSize ?? model.size)}</span>{model.estimatedMemoryBytes ? <span><Cpu aria-hidden="true" />~{formatDownloadSize(model.estimatedMemoryBytes)} memory</span> : null}</div>
              {active ? <div className="onboarding__model-progress" aria-live="polite">
                <div className="onboarding__progress-label"><span>{progress?.status ?? 'Preparing download…'}</span>{progress?.percent !== undefined ? <strong>{Math.round(progress.percent)}%</strong> : null}</div>
                <progress aria-label={`${model.name} download progress`} max={100} value={progress?.percent} />
                {progress?.total ? <small>{formatDownloadSize(progress.completed ?? 0)} of {formatDownloadSize(progress.total)}</small> : null}
              </div> : null}
              {failed ? <div className="onboarding__provider-error" role="alert">{failed}</div> : progress?.cancelled ? <p className="onboarding__supporting-copy">Download cancelled. Retry to resume.</p> : null}
              {actions.errors[`cancel:${key}`] ? <div className="onboarding__provider-error" role="alert">{actions.errors[`cancel:${key}`]}</div> : null}
              <div className="onboarding__model-action">
                {active ? <button type="button" className="onboarding__button onboarding__button--secondary onboarding__button--compact" disabled={!progress || progress.done || actions.pending[`cancel:${key}`]} onClick={() => actions.run(`cancel:${key}`, () => onCancelModelPull(model.id))} aria-label={`Cancel ${model.name} download`}><X aria-hidden="true" />Cancel download</button> : installed ? <span className="onboarding__model-installed"><CheckCircle2 aria-hidden="true" />Ready to use</span> : <button type="button" className="onboarding__button onboarding__button--install" disabled={!isReady} onClick={() => actions.run(key, () => onPullModel(model.id))} aria-label={`Download ${model.name}`}><Download aria-hidden="true" />{failed || progress?.cancelled ? 'Retry download' : 'Download model'}</button>}
              </div>
            </article>
          })}
        </div>
        {!featuredModels.length ? <p className="onboarding__supporting-copy">{modelCatalog.length ? 'Your recommended models are already installed. More models are available in the Models view after setup.' : 'The model catalog has not loaded yet. Select Refresh to try again.'}</p> : null}
      </section>
      <p className="onboarding__supporting-copy">Local AI is optional. Model downloads continue as you move through setup. More models and download controls are available in the Models view.</p>
    </div>
  )
}

const CLOUD_PROVIDERS = [
  {
    id: 'openai' as const,
    name: 'OpenAI',
    description: 'Cloud coding, chat, and agent-capable models.'
  },
  {
    id: 'anthropic' as const,
    name: 'Anthropic',
    description: 'Claude models for reasoning and software tasks.'
  },
  {
    id: 'google' as const,
    name: 'Google',
    description: 'Gemini models with long-context capabilities.'
  }
]

function CloudAiStep({ onSaveProvider }: Pick<OnboardingProps, 'onSaveProvider'>): ReactNode {
  const [editing, setEditing] = useState<(typeof CLOUD_PROVIDERS)[number]['id'] | null>(null)
  const [keys, setKeys] = useState<Record<(typeof CLOUD_PROVIDERS)[number]['id'], string>>({ openai: '', anthropic: '', google: '' })
  const [saved, setSaved] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="onboarding__ai-stack">
      <section className="onboarding__provider-list" aria-label="Optional cloud AI providers">
        {CLOUD_PROVIDERS.map((provider) => (
          <article className="onboarding__provider" key={provider.name}>
            <span className="onboarding__provider-monogram" aria-hidden="true">
              {provider.name.slice(0, 1)}
            </span>
            <span>
              <strong>{provider.name}</strong>
              <small>{provider.description}</small>
            </span>
            <button className="onboarding__setup-later" disabled={busy} onClick={() => setEditing((current) => current === provider.id ? null : provider.id)} type="button">{saved.has(provider.id) ? 'Stored' : editing === provider.id ? 'Cancel' : 'Configure'}</button>
            {editing === provider.id ? <form className="onboarding__provider-form" onSubmit={async (event) => {
              event.preventDefault()
              if (!keys[provider.id].trim() || busy) return
              setBusy(true); setError('')
              try {
                await onSaveProvider(provider.id, keys[provider.id])
                setSaved((current) => new Set(current).add(provider.id))
                setKeys((current) => ({ ...current, [provider.id]: '' }))
                setEditing(null)
              } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
              finally { setBusy(false) }
            }}><KeyRound /><input autoFocus type="password" autoComplete="off" value={keys[provider.id]} onChange={(event) => setKeys((current) => ({ ...current, [provider.id]: event.target.value }))} placeholder={`${provider.name} API key`} /><button disabled={!keys[provider.id].trim() || busy}>{busy ? 'Saving…' : 'Save to Keychain'}</button></form> : null}
          </article>
        ))}
      </section>

      {error ? <div className="onboarding__provider-error" role="alert">{error}</div> : null}

      <section className="onboarding__privacy-note">
        <KeyRound aria-hidden="true" />
        <div>
          <strong>Credentials belong in Keychain</strong>
          <p>
            Configure a provider later in Settings → AI → Providers. OmniCode stores credentials in macOS
            Keychain and shows which project context will be transmitted before a cloud request.
          </p>
        </div>
      </section>
    </div>
  )
}

function WorkspaceStep({
  busyAction,
  onOpenFolder,
  onCloneRepository,
  onCreateProject
}: {
  busyAction: 'open-folder' | 'clone' | 'create' | 'complete' | null
  onOpenFolder: () => void
  onCloneRepository: () => void
  onCreateProject: () => void
}): ReactNode {
  return (
    <div className="onboarding__workspace-stack">
      <section className="onboarding__ready-card">
        <span className="onboarding__ready-mark">
          <Check aria-hidden="true" />
        </span>
        <div>
          <span className="onboarding__eyebrow">Setup complete</span>
          <h3>Your editor is ready.</h3>
          <p>
            Open any folder your Mac can access. OmniCode will ask through macOS when a protected location
            needs permission.
          </p>
        </div>
      </section>

      <button
        className="onboarding__workspace-action"
        disabled={busyAction !== null}
        onClick={onOpenFolder}
        type="button"
      >
        <span className="onboarding__workspace-icon">
          {busyAction === 'open-folder' ? (
            <LoaderCircle className="onboarding__spin" aria-hidden="true" />
          ) : (
            <FolderOpen aria-hidden="true" />
          )}
        </span>
        <span>
          <strong>{busyAction === 'open-folder' ? 'Opening folder picker…' : 'Open a folder'}</strong>
          <small>Choose an existing project with the native macOS folder picker.</small>
        </span>
        <ArrowRight aria-hidden="true" />
      </button>

      <div className="onboarding__workspace-secondary">
        <button disabled={busyAction !== null} onClick={onCloneRepository} type="button">{busyAction === 'clone' ? <LoaderCircle className="onboarding__spin" /> : <GitFork />}<span><strong>Clone Git Repository</strong><small>Choose a remote URL and destination folder.</small></span></button>
        <button disabled={busyAction !== null} onClick={onCreateProject} type="button">{busyAction === 'create' ? <LoaderCircle className="onboarding__spin" /> : <Plus />}<span><strong>Create New Project</strong><small>Start with an empty folder in a location you choose.</small></span></button>
      </div>

      <p className="onboarding__supporting-copy onboarding__supporting-copy--centered">
        You can also clone a repository or create a new project from the Welcome screen after setup.
      </p>
    </div>
  )
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

export function Onboarding({
  detectedTools,
  ollama,
  appearance,
  onAppearanceChange,
  onComplete,
  onOpenFolder,
  onCloneRepository,
  onCreateProject,
  onSaveProvider,
  toolInstallations,
  modelCatalog,
  modelPulls,
  onInstallTool,
  onCancelToolInstallation,
  onRefreshSetup,
  onPullModel,
  onCancelModelPull
}: OnboardingProps): ReactNode {
  const [activeStep, setActiveStep] = useState(0)
  const [highestVisitedStep, setHighestVisitedStep] = useState(0)
  const [busyAction, setBusyAction] = useState<'open-folder' | 'clone' | 'create' | 'complete' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [setupErrors, setSetupErrors] = useState<Record<string, string>>({})
  const pendingRef = useRef(new Set<string>())
  const headingRef = useRef<HTMLHeadingElement>(null)

  const setupActions: SetupActions = {
    pending,
    errors: setupErrors,
    run: (key, action) => {
      if (pendingRef.current.has(key)) return
      pendingRef.current.add(key)
      setPending((current) => ({ ...current, [key]: true }))
      setSetupErrors((current) => ({ ...current, [key]: '' }))
      void Promise.resolve().then(action).catch((error: unknown) => {
        setSetupErrors((current) => ({ ...current, [key]: errorText(error, 'This action could not be completed. Please try again.') }))
      }).finally(() => {
        pendingRef.current.delete(key)
        setPending((current) => ({ ...current, [key]: false }))
      })
    }
  }
  const toolInstallBusy = Object.values(toolInstallations).some((item) => !item.done) || Object.entries(pending).some(([key, value]) => key.startsWith('tool:') && value)
  const backgroundDownloads = Object.values(toolInstallations).some((item) => !item.done) || Object.values(modelPulls).some((item) => !item.done)
  const toolListProps = { toolInstallations, onInstallTool, onCancelToolInstallation, onRefreshSetup, actions: setupActions, toolInstallBusy }

  const developmentTools = useMemo(
    () => detectedTools.filter((tool) => isDevelopmentTool(tool)),
    [detectedTools]
  )
  const runtimes = useMemo(
    () => detectedTools.filter((tool) => !isDevelopmentTool(tool)),
    [detectedTools]
  )

  const step = STEPS[activeStep]
  const isFinalStep = activeStep === STEPS.length - 1
  const isAiStep = activeStep === 3 || activeStep === 4

  useEffect(() => {
    headingRef.current?.focus()
  }, [activeStep])

  function navigateTo(stepIndex: number): void {
    if (stepIndex < 0 || stepIndex >= STEPS.length || stepIndex > highestVisitedStep) return
    setActionError(null)
    setActiveStep(stepIndex)
  }

  function goForward(): void {
    const nextStep = Math.min(activeStep + 1, STEPS.length - 1)
    setHighestVisitedStep((current) => Math.max(current, nextStep))
    setActionError(null)
    setActiveStep(nextStep)
  }

  function goBack(): void {
    if (activeStep === 0) return
    setActionError(null)
    setActiveStep((current) => current - 1)
  }

  async function handleOpenFolder(): Promise<void> {
    if (busyAction) return
    setActionError(null)
    setBusyAction('open-folder')

    try {
      await onOpenFolder()
    } catch (error) {
      setActionError(errorText(error, 'The folder picker could not be opened. Please try again.'))
    } finally {
      setBusyAction(null)
    }
  }

  async function handleWorkspaceAction(kind: 'clone' | 'create', action: () => void | Promise<void>): Promise<void> {
    if (busyAction) return
    setActionError(null)
    setBusyAction(kind)
    try { await action() }
    catch (error) { setActionError(errorText(error, `The ${kind === 'clone' ? 'repository' : 'project'} could not be created.`)) }
    finally { setBusyAction(null) }
  }

  async function handleComplete(): Promise<void> {
    if (busyAction) return
    setActionError(null)
    setBusyAction('complete')

    try {
      await onComplete()
    } catch (error) {
      setActionError(errorText(error, 'Setup could not be completed. Please try again.'))
    } finally {
      setBusyAction(null)
    }
  }

  function renderStep(): ReactNode {
    switch (activeStep) {
      case 0:
        return (
          <AppearanceStep appearance={appearance} onAppearanceChange={onAppearanceChange} />
        )
      case 1:
        return (
          <ToolList
            {...toolListProps}
            emptyMessage="Development tool detection will appear here when the system check finishes."
            tools={developmentTools}
          />
        )
      case 2:
        return (
          <ToolList
            {...toolListProps}
            emptyMessage="No programming runtimes have reported a result yet. You can continue and check again later."
            tools={runtimes}
          />
        )
      case 3:
        return <LocalAiStep {...toolListProps} ollama={ollama} modelCatalog={modelCatalog} modelPulls={modelPulls} onPullModel={onPullModel} onCancelModelPull={onCancelModelPull} />
      case 4:
        return <CloudAiStep onSaveProvider={onSaveProvider} />
      case 5:
        return <WorkspaceStep busyAction={busyAction} onOpenFolder={() => void handleOpenFolder()} onCloneRepository={() => void handleWorkspaceAction('clone', onCloneRepository)} onCreateProject={() => void handleWorkspaceAction('create', onCreateProject)} />
      default:
        return null
    }
  }

  return (
    <main
      className="onboarding"
      data-appearance={appearance}
      aria-label="Welcome to OmniCode"
    >
      <div className="onboarding__window">
        <aside className="onboarding__rail">
          <div className="onboarding__brand">
            <span className="onboarding__brand-mark">
              <Code2 aria-hidden="true" />
            </span>
            <span>
              <strong>OmniCode</strong>
              <small>First-launch setup</small>
            </span>
          </div>

          <nav className="onboarding__steps" aria-label="Setup progress">
            <ol>
              {STEPS.map((item, index) => {
                const Icon = item.icon
                const selected = index === activeStep
                const completed = index !== activeStep && index <= highestVisitedStep
                const accessible = index <= highestVisitedStep

                return (
                  <li key={item.shortTitle}>
                    <button
                      aria-current={selected ? 'step' : undefined}
                      aria-label={`Step ${index + 1}: ${item.shortTitle}${completed ? ', visited' : ''}`}
                      className={`${selected ? 'is-current' : ''}${completed ? ' is-complete' : ''}`}
                      disabled={!accessible || busyAction !== null}
                      onClick={() => navigateTo(index)}
                      type="button"
                    >
                      <span className="onboarding__step-icon">
                        {completed && !selected ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}
                      </span>
                      <span>
                        <small>Step {index + 1}</small>
                        <strong>{item.shortTitle}</strong>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </nav>

          <div className="onboarding__rail-note">
            <ShieldCheck aria-hidden="true" />
            <span>
              <strong>Private by default</strong>
              <small>AI is optional and always under your control.</small>
            </span>
          </div>
        </aside>

        <section className="onboarding__main">
          <header className="onboarding__header">
            <div className="onboarding__step-count" aria-live="polite">
              Step {activeStep + 1} of {STEPS.length}
            </div>
            <h1 ref={headingRef} tabIndex={-1}>
              {step.title}
            </h1>
            <p>{step.description}</p>
          </header>

          <div className="onboarding__body">{renderStep()}</div>

          <footer className="onboarding__footer">
            <div className="onboarding__footer-status">
              {actionError ? (
                <span className="onboarding__action-error" role="alert">
                  <CircleAlert aria-hidden="true" />
                  {actionError}
                </span>
              ) : backgroundDownloads ? (
                <span>Downloads are running in the background.</span>
              ) : isAiStep ? (
                <span>Optional — no AI account or model is required.</span>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>

            <div className="onboarding__footer-actions">
              <button
                className="onboarding__button onboarding__button--secondary"
                disabled={activeStep === 0 || busyAction !== null}
                onClick={goBack}
                type="button"
              >
                <ArrowLeft aria-hidden="true" />
                Back
              </button>

              {isFinalStep ? (
                <button
                  className="onboarding__button onboarding__button--primary"
                  disabled={busyAction !== null}
                  onClick={() => void handleComplete()}
                  type="button"
                >
                  {busyAction === 'complete' ? (
                    <LoaderCircle className="onboarding__spin" aria-hidden="true" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  {busyAction === 'complete' ? 'Finishing…' : 'Finish setup'}
                </button>
              ) : (
                <button
                  className="onboarding__button onboarding__button--primary"
                  disabled={busyAction !== null}
                  onClick={goForward}
                  type="button"
                >
                  {activeStep === 3
                    ? (ollama.models?.length || Object.keys(modelPulls).length ? 'Continue' : 'Skip local AI')
                    : activeStep === 4
                      ? 'Skip cloud AI'
                      : 'Continue'}
                  <ArrowRight aria-hidden="true" />
                </button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </main>
  )
}

export default Onboarding
