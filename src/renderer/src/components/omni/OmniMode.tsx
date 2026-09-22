import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AudioWaveform, Bot, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Clock3, Code2,
  EyeOff, FileText, FolderSync, History, LoaderCircle, Mic, MonitorCog, MousePointer2, Pause, Play, RefreshCw,
  Send, ShieldCheck, Sparkles, Square, Terminal, Volume2, WandSparkles, X, XCircle, Zap,
} from 'lucide-react'

import type { AIModel, AIProviderId, OmniSettingsChanges } from '../../../../shared/contracts'
import type { CloudAIProviderId } from '../../../../shared/model-contracts'
import type {
  OmniEvent, OmniExecutionMode, OmniInstalledVoice, OmniPermissionId, OmniPermissionState,
  OmniPermissionsSnapshot, OmniSettings, OmniSpeechInputAvailability, OmniStatus, OmniTask, OmniTaskSummary,
  OmniVoiceAvailability,
} from '../../../../shared/omni-contracts'
import type { WorkApprovalMode } from '../../../../shared/tool-contracts'
import {
  OMNI_CURSOR_EMERGENCY_STOP_LABEL, OMNI_CURSOR_EMERGENCY_STOP_SHORTCUT, type OmniCursorRuntimeStatus
} from '../../../../shared/omni-cursor-contracts'
import './OmniMode.css'

const TERMINAL_STATUSES = new Set<OmniStatus>(['completed', 'failed', 'stopped'])
const PAUSABLE_STATUSES = new Set<OmniStatus>([
  'listening', 'transcribing', 'planning', 'waiting-for-approval', 'working', 'using-cursor', 'speaking'
])
const PROVIDERS: Array<{ id: AIProviderId; label: string; group: 'Local' | 'Cloud' }> = [
  { id: 'ollama', label: 'Ollama', group: 'Local' },
  { id: 'openai', label: 'OpenAI', group: 'Cloud' },
  { id: 'anthropic', label: 'Claude', group: 'Cloud' },
  { id: 'google', label: 'Google Gemini', group: 'Cloud' },
]
const PERMISSIONS: Array<{ id: OmniPermissionId; label: string; detail: string; optional?: boolean }> = [
  { id: 'microphone', label: 'Microphone', detail: 'Voice commands and speech input' },
  { id: 'speech-recognition', label: 'Speech Recognition', detail: 'Convert your voice into requests' },
  { id: 'accessibility', label: 'Accessibility', detail: 'Required only for Cursor Mode', optional: true },
  { id: 'screen-recording', label: 'Screen Recording', detail: 'Understand visible interfaces when requested', optional: true },
  { id: 'automation', label: 'Automation', detail: 'Interact with supported macOS applications', optional: true },
  { id: 'files-and-folders', label: 'Files & Folders', detail: 'Use locations you explicitly approve', optional: true },
]
const SETUP_STEPS = ['Welcome', 'Permissions', 'Voice', 'AI', 'Execution', 'Activation', 'Ready'] as const
const ACTIVITY_LIMIT = 40

type PresentedError = { title: string; message: string; detail: string }

async function fetchOmniModels(provider: AIProviderId): Promise<AIModel[]> {
  if (provider === 'ollama') return window.omnicode.ai.models()
  const result = await window.omnicode.ai.cloudModelCatalog(provider as CloudAIProviderId, {})
  return result.models
    .filter((model) => model.availability !== 'unavailable' && model.capabilities.chat.support !== 'unsupported')
    .map((model) => ({
      id: model.id, name: model.displayName, provider: model.provider, local: false,
      description: model.description, contextWindow: model.contextWindow,
      capabilities: Object.entries(model.capabilities).filter(([, capability]) => capability.support === 'supported').map(([name]) => name),
      toolUse: model.capabilities['tool-calling'].support === 'supported'
    }))
}

export function isTerminalOmniStatus(status: OmniStatus): boolean { return TERMINAL_STATUSES.has(status) }

export function displayedOmniApprovalMode(
  settingsMode: WorkApprovalMode | undefined,
  task: Pick<OmniTask, 'status' | 'approvalMode'> | null
): WorkApprovalMode {
  return task && !isTerminalOmniStatus(task.status) ? task.approvalMode : settingsMode ?? 'ask'
}

export function humanizeOmniStatus(status: OmniStatus): string {
  return status.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

export function humanizeOmniError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').replace(/^Error:\s*/i, '')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{20,})\b/gu, '[REDACTED]')
    .replace(/((?:api|access|refresh)[_-]?(?:key|token)\s*[:=]\s*)[^\s,;}]+/giu, '$1[REDACTED]').slice(0, 1_000)
}

export function presentOmniError(cause: unknown): PresentedError {
  const detail = humanizeOmniError(cause)
  if (/\b503\b|high demand|overload|service unavailable/iu.test(detail)) return {
    title: 'AI provider unavailable', message: 'The selected model is temporarily busy. Try again or choose another model.', detail
  }
  if (/401|403|auth(?:entication|orization)|invalid (?:api )?key|credential/iu.test(detail)) return {
    title: 'Provider authentication failed', message: 'Reconnect this provider or update its credential in AI Provider settings.', detail
  }
  if (/429|rate.?limit|quota/iu.test(detail)) return {
    title: 'Provider limit reached', message: 'The provider is limiting requests. Wait briefly or switch to another model.', detail
  }
  if (/voice|speech|microphone/iu.test(detail)) return {
    title: 'Voice input unavailable', message: 'Check Omni voice and macOS permission settings.', detail
  }
  return { title: 'Omni needs attention', message: detail || 'The request could not be completed.', detail }
}

export function OmniMode({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<OmniSettings | null>(null)
  const [history, setHistory] = useState<OmniTaskSummary[]>([])
  const [task, setTask] = useState<OmniTask | null>(null)
  const [permissions, setPermissions] = useState<OmniPermissionsSnapshot | null>(null)
  const [models, setModels] = useState<AIModel[]>([])
  const [voiceOutput, setVoiceOutput] = useState<OmniVoiceAvailability>({ available: false, reason: 'Checking macOS speech output…' })
  const [voiceInput, setVoiceInput] = useState<OmniSpeechInputAvailability>({
    available: false, providerId: 'macos-speech', reason: 'Checking on-device speech recognition…',
    microphonePermission: 'unavailable', speechRecognitionPermission: 'unavailable', onDevice: false,
    streaming: false, locale: 'en-US', supportedLocales: []
  })
  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(null)
  const [cursorStatus, setCursorStatus] = useState<OmniCursorRuntimeStatus>({
    accessibility: 'unavailable', nativeHelper: 'unavailable', emergencyStop: 'unavailable',
    emergencyStopShortcut: OMNI_CURSOR_EMERGENCY_STOP_SHORTCUT, checkedAt: 0
  })
  const [installedVoices, setInstalledVoices] = useState<OmniInstalledVoice[]>([])
  const [requestText, setRequestText] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [controllerAvailable, setControllerAvailable] = useState(false)
  const [setupStep, setSetupStep] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PresentedError | null>(null)

  const refreshTask = useCallback(async (taskId: string) => {
    const next = await window.omnicode.omni.tasks.get(taskId)
    setTask(next)
    return next
  }, [])

  const refreshEnvironment = useCallback(async () => {
    const [nextPermissions, nextVoiceOutput, nextVoiceInput, nextCursorStatus] = await Promise.all([
      window.omnicode.omni.permissions.status(),
      window.omnicode.omni.voice.availability().catch(() => ({ available: false, reason: 'macOS speech output is unavailable.' })),
      window.omnicode.omni.voice.inputAvailability().catch(() => ({
        available: false, providerId: 'macos-speech', reason: 'On-device speech recognition is unavailable.',
        microphonePermission: 'unavailable' as const, speechRecognitionPermission: 'unavailable' as const,
        onDevice: false, streaming: false, locale: 'en-US', supportedLocales: []
      })),
      window.omnicode.omni.cursor.status().catch(() => ({
        accessibility: 'unavailable' as const, nativeHelper: 'unavailable' as const,
        emergencyStop: 'unavailable' as const,
        emergencyStopShortcut: OMNI_CURSOR_EMERGENCY_STOP_SHORTCUT as typeof OMNI_CURSOR_EMERGENCY_STOP_SHORTCUT,
        checkedAt: Date.now()
      }))
    ])
    setPermissions(nextPermissions); setVoiceOutput(nextVoiceOutput); setVoiceInput(nextVoiceInput); setCursorStatus(nextCursorStatus)
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [nextSettings, tasks, nextVoices] = await Promise.all([
        window.omnicode.omni.settings.get(), window.omnicode.omni.tasks.list(),
        window.omnicode.omni.voice.voices().catch(() => [] as OmniInstalledVoice[]), refreshEnvironment()
      ])
      setSettings(nextSettings); setModelDraft(nextSettings.model.modelId); setHistory(tasks); setInstalledVoices(nextVoices)
      setModels(await fetchOmniModels(nextSettings.model.provider).catch(() => [])); setControllerAvailable(true)
      const current = tasks.find((candidate) => !isTerminalOmniStatus(candidate.status)) ?? tasks[0]
      if (current) await refreshTask(current.id); else setTask(null)
    } catch (cause) { setControllerAvailable(false); setError(presentOmniError(cause)) }
    finally { setLoading(false) }
  }, [refreshEnvironment, refreshTask])

  useEffect(() => {
    void load()
    const unsubscribeSettings = window.omnicode.omni.settings.onChanged((next) => {
      setSettings(next); setModelDraft(next.model.modelId); setControllerAvailable(true)
      void fetchOmniModels(next.model.provider).then(setModels).catch(() => setModels([]))
    })
    const unsubscribeTask = window.omnicode.omni.tasks.onTaskChanged((changed) => {
      setHistory((current) => [changed, ...current.filter((candidate) => candidate.id !== changed.id)]
        .sort((left, right) => right.updatedAt - left.updatedAt))
      setTask((current) => {
        if (!isTerminalOmniStatus(changed.status) || current?.id === changed.id) {
          void refreshTask(changed.id).catch((cause) => setError(presentOmniError(cause)))
        }
        return current
      })
    })
    const unsubscribeEvent = window.omnicode.omni.tasks.onEvent((event) => setTask((current) => {
      if (!current || current.id !== event.taskId) return current
      return { ...current, events: [...current.events.filter((candidate) => candidate.id !== event.id), event].sort((a, b) => a.timestamp - b.timestamp) }
    }))
    const unsubscribeVoiceInput = window.omnicode.omni.voice.onInputEvent((event) => {
      if (event.type === 'listening') setVoiceSessionId(event.sessionId)
      if ((event.type === 'partial' || event.type === 'final') && event.transcript !== undefined) setRequestText(event.transcript)
      if (event.type === 'final' || event.type === 'cancelled') setVoiceSessionId((current) => current === event.sessionId ? null : current)
      if (event.type === 'error') {
        setVoiceSessionId((current) => current === event.sessionId ? null : current)
        setError(presentOmniError(event.error ?? 'Voice recognition failed.'))
      }
    })
    return () => { unsubscribeSettings(); unsubscribeTask(); unsubscribeEvent(); unsubscribeVoiceInput() }
  }, [load, refreshTask])

  useEffect(() => {
    if (!active) {
      if (voiceSessionId) {
        const sessionId = voiceSessionId; setVoiceSessionId(null)
        void window.omnicode.omni.voice.cancelInput(sessionId).catch(() => undefined)
      }
      return
    }
    const refresh = () => void refreshEnvironment().catch(() => undefined)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [active, refreshEnvironment, voiceSessionId])

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null)
    try { return await operation() }
    catch (cause) { setError(presentOmniError(cause)); return undefined }
    finally { setBusy(false) }
  }, [])

  const updateSettings = useCallback(async (changes: OmniSettingsChanges, acknowledgeFullAccess = false) => {
    const next = await run(() => window.omnicode.omni.settings.update(changes, acknowledgeFullAccess))
    if (next) { setSettings(next); setModelDraft(next.model.modelId) }
    return next
  }, [run])

  const changeApprovalMode = useCallback(async (mode: WorkApprovalMode) => {
    if (mode === 'full') {
      const acknowledged = window.confirm('Full Access lets Omni perform supported actions without asking each time. Critical, financial, account-security, and irreversible destructive actions still require approval. Enable Full Access?')
      if (!acknowledged) return
      await updateSettings({ approvalMode: mode }, true); return
    }
    await updateSettings({ approvalMode: mode })
  }, [updateSettings])

  const changeExecutionMode = useCallback(async (mode: OmniExecutionMode) => {
    if (task && !isTerminalOmniStatus(task.status)) {
      const next = await run(() => window.omnicode.omni.tasks.switchExecutionMode(task.id, mode)); if (next) setTask(next); return
    }
    await updateSettings({ executionMode: mode })
  }, [run, task, updateSettings])

  const changeProvider = useCallback(async (provider: AIProviderId) => {
    const nextModels = await run(() => fetchOmniModels(provider)); if (!nextModels) return
    setModels(nextModels); const nextModel = nextModels[0]?.id ?? ''; setModelDraft(nextModel)
    await updateSettings({ model: { provider, modelId: nextModel } })
  }, [run, updateSettings])

  const startTask = useCallback(async (providedInput?: string) => {
    if (!settings || !settings.enabled || voiceSessionId) return
    const input = (providedInput ?? requestText).trim(); if (!input) return
    const requestedModel = modelDraft.trim()
    if (!requestedModel) { setError(presentOmniError('Choose an available model before starting an Omni task.')); return }
    let taskSettings = settings
    if (requestedModel !== settings.model.modelId) {
      const updated = await updateSettings({ model: { modelId: requestedModel } }); if (!updated) return; taskSettings = updated
    }
    const started = await run(() => window.omnicode.omni.tasks.start({
      provider: taskSettings.model.provider, model: taskSettings.model.modelId, input, activationSource: 'main-window',
      executionMode: taskSettings.executionMode, approvalMode: taskSettings.approvalMode,
    }))
    if (!started) return
    setTask(started); setHistory((current) => [started, ...current.filter((candidate) => candidate.id !== started.id)]); setRequestText('')
  }, [modelDraft, requestText, run, settings, updateSettings, voiceSessionId])

  const toggleVoiceInput = useCallback(async (submitWhenStopped = true) => {
    if (voiceSessionId) {
      const result = await run(() => window.omnicode.omni.voice.stopInput(voiceSessionId)); setVoiceSessionId(null)
      if (result?.transcript) { setRequestText(result.transcript); if (submitWhenStopped && settings?.setupCompleted) await startTask(result.transcript) }
      return
    }
    setRequestText('')
    const started = await run(() => window.omnicode.omni.voice.startInput({ locale: voiceInput.locale, requireOnDevice: true }))
    if (started) setVoiceSessionId(started.sessionId)
  }, [run, settings?.setupCompleted, startTask, voiceInput.locale, voiceSessionId])

  const controlTask = useCallback(async (action: 'pause' | 'resume' | 'stop') => {
    if (!task) return
    const next = await run(() => window.omnicode.omni.tasks[action](task.id)); if (next) setTask(next)
  }, [run, task])

  const taskRunning = Boolean(task && !isTerminalOmniStatus(task.status))
  const cursorReady = cursorStatus.accessibility === 'granted' && cursorStatus.nativeHelper === 'available' && cursorStatus.emergencyStop === 'registered'
  const providerModels = useMemo(() => settings ? models.filter((model) => model.provider === settings.model.provider && model.installed !== false) : [], [models, settings])

  if (!settings) return <OmniLoading loading={loading} error={error} onRetry={() => void load()} />

  if (!settings.setupCompleted) return <OmniSetupWizard
    settings={settings} step={setupStep} permissions={permissions} voiceInput={voiceInput} voiceOutput={voiceOutput}
    voiceSessionId={voiceSessionId} transcript={requestText} voices={installedVoices} models={providerModels}
    modelDraft={modelDraft} cursorReady={cursorReady} busy={busy} error={error} onDismissError={() => setError(null)}
    onStep={setSetupStep} onRefresh={() => void refreshEnvironment().catch((cause) => setError(presentOmniError(cause)))}
    onUpdate={updateSettings} onProvider={changeProvider}
    onModel={(modelId) => { setModelDraft(modelId); void updateSettings({ model: { modelId } }) }}
    onApproval={changeApprovalMode} onVoice={() => void toggleVoiceInput(false)}
    onVoiceTest={() => void run(() => window.omnicode.omni.voice.test())}
    onFinish={() => void updateSettings({ enabled: true, setupCompleted: true })}
  />

  return <OmniDashboard active={active} settings={settings} task={task} history={history} models={providerModels}
    modelDraft={modelDraft} controllerAvailable={controllerAvailable} voiceInput={voiceInput} voiceOutput={voiceOutput}
    voiceSessionId={voiceSessionId} requestText={requestText} cursorReady={cursorReady} busy={busy} loading={loading}
    error={error} historyOpen={historyOpen} onDismissError={() => setError(null)} onRetry={() => void load()}
    onProvider={changeProvider} onModel={(modelId) => { setModelDraft(modelId); void updateSettings({ model: { modelId } }) }}
    onExecution={changeExecutionMode} onApproval={changeApprovalMode} onRequest={setRequestText} onStart={() => void startTask()}
    onVoice={() => void toggleVoiceInput(true)} onControl={(action) => void controlTask(action)} onHistory={() => setHistoryOpen(true)}
    onCloseHistory={() => setHistoryOpen(false)}
    onSelectHistory={(id) => void refreshTask(id).then(() => setHistoryOpen(false)).catch((cause) => setError(presentOmniError(cause)))} />
}

function OmniLoading({ loading, error, onRetry }: { loading: boolean; error: PresentedError | null; onRetry(): void }) {
  return <section className="omni-mode omni-loading-screen" aria-label="Omni mode"><div className="omni-loading-mark"><AudioWaveform /></div>
    <h1>{error ? error.title : 'Starting Omni'}</h1><p>{error?.message ?? 'Connecting to the Omni controller and checking local capabilities…'}</p>
    {loading ? <LoaderCircle className="omni-spin" /> : <button type="button" onClick={onRetry}><RefreshCw />Try again</button>}</section>
}

function OmniSetupWizard({
  settings, step, permissions, voiceInput, voiceOutput, voiceSessionId, transcript, voices, models, modelDraft,
  cursorReady, busy, error, onDismissError, onStep, onRefresh, onUpdate, onProvider, onModel, onApproval,
  onVoice, onVoiceTest, onFinish
}: {
  settings: OmniSettings; step: number; permissions: OmniPermissionsSnapshot | null
  voiceInput: OmniSpeechInputAvailability; voiceOutput: OmniVoiceAvailability; voiceSessionId: string | null
  transcript: string; voices: OmniInstalledVoice[]; models: AIModel[]; modelDraft: string; cursorReady: boolean
  busy: boolean; error: PresentedError | null; onDismissError(): void; onStep(value: number): void; onRefresh(): void
  onUpdate(changes: OmniSettingsChanges, acknowledgeFullAccess?: boolean): Promise<OmniSettings | undefined>
  onProvider(provider: AIProviderId): Promise<void>; onModel(modelId: string): void; onApproval(mode: WorkApprovalMode): Promise<void>
  onVoice(): void; onVoiceTest(): void; onFinish(): void
}) {
  const granted = PERMISSIONS.filter(({ id }) => permissions?.permissions[id] === 'granted').length
  const nextDisabled = step === 3 && (!settings.model.modelId || !modelDraft)
  return <section className="omni-mode omni-setup" aria-label="Set up Omni"><div className="omni-setup-shell">
    <header className="omni-setup-header"><span className="omni-setup-logo"><AudioWaveform /></span>
      <span><strong>Set Up Omni</strong><small>Your voice-first system assistant</small></span>
      <span className="omni-setup-count">{step + 1} of {SETUP_STEPS.length}</span></header>
    <ol className="omni-setup-progress" aria-label="Setup progress">{SETUP_STEPS.map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'complete' : ''}>
      <span>{index < step ? <Check /> : index + 1}</span><small>{label}</small></li>)}</ol>
    <main className="omni-setup-content">
      {error && <OmniAlert error={error} onDismiss={onDismissError} />}
      {step === 0 && <SetupIntro />}
      {step === 1 && <SetupPermissions permissions={permissions} granted={granted} onRefresh={onRefresh} />}
      {step === 2 && <SetupVoice settings={settings} input={voiceInput} output={voiceOutput} sessionId={voiceSessionId}
        transcript={transcript} voices={voices} busy={busy} onUpdate={onUpdate} onVoice={onVoice} onVoiceTest={onVoiceTest} />}
      {step === 3 && <SetupAI settings={settings} models={models} modelDraft={modelDraft} busy={busy} onProvider={onProvider} onModel={onModel} />}
      {step === 4 && <SetupExecution settings={settings} cursorReady={cursorReady} busy={busy} onUpdate={onUpdate} onApproval={onApproval} />}
      {step === 5 && <SetupActivation settings={settings} busy={busy} onUpdate={onUpdate} />}
      {step === 6 && <SetupReady settings={settings} permissions={permissions} cursorReady={cursorReady} />}
    </main>
    <footer className="omni-setup-footer"><button type="button" className="omni-secondary-button" disabled={step === 0 || busy} onClick={() => onStep(step - 1)}><ChevronLeft />Back</button>
      {step < SETUP_STEPS.length - 1
        ? <button type="button" className="omni-primary-button" disabled={busy || nextDisabled} onClick={() => onStep(step + 1)}>{step === 0 ? 'Set Up Omni' : 'Continue'}<ChevronRight /></button>
        : <button type="button" className="omni-primary-button" disabled={busy} onClick={onFinish}><Sparkles />Start Omni</button>}
    </footer>
  </div></section>
}

function SetupIntro() {
  return <div className="omni-setup-intro"><div className="omni-setup-orb" aria-hidden="true"><span /><AudioWaveform /></div>
    <p className="omni-kicker">MEET OMNI</p><h1>Your voice-first AI assistant.</h1>
    <p>Omni can code, work with approved files and connected services, browse the web, and perform tasks across your Mac.</p>
    <div className="omni-capability-grid"><span><Code2 /><strong>Code</strong><small>Build, run, and debug</small></span>
      <span><FolderSync /><strong>Work</strong><small>Research and organize</small></span>
      <span><WandSparkles /><strong>Automate</strong><small>Use approved tools</small></span>
      <span><Mic /><strong>Voice-first</strong><small>Speak naturally</small></span></div>
  </div>
}

function SetupPermissions({ permissions, granted, onRefresh }: { permissions: OmniPermissionsSnapshot | null; granted: number; onRefresh(): void }) {
  return <div className="omni-setup-step"><div className="omni-setup-title"><span><ShieldCheck /></span><div><p className="omni-kicker">SYSTEM ACCESS</p><h1>System Permissions</h1><p>{granted} of {PERMISSIONS.length} currently enabled. Optional capabilities will not block setup.</p></div></div>
    <div className="omni-permission-progress"><span style={{ width: `${Math.round(granted / PERMISSIONS.length * 100)}%` }} /></div>
    <div className="omni-permission-list">{PERMISSIONS.map((permission) => <PermissionRow key={permission.id} permission={permission} state={permissions?.permissions[permission.id] ?? 'not-determined'} />)}</div>
    <button type="button" className="omni-secondary-button" onClick={onRefresh}><RefreshCw />Refresh permission state</button>
  </div>
}

function PermissionRow({ permission, state }: { permission: typeof PERMISSIONS[number]; state: OmniPermissionState }) {
  const granted = state === 'granted'
  return <div className="omni-permission-row" data-state={state}><span className="omni-permission-icon">{granted ? <Check /> : <CircleAlert />}</span>
    <span><strong>{permission.label}{permission.optional && <em>Optional</em>}</strong><small>{permission.detail}</small></span>
    <span className="omni-permission-state">{permissionStateLabel(state)}</span>
    {!granted && state !== 'unavailable' && <button type="button" onClick={() => void window.omnicode.omni.permissions.openSettings(permission.id)}>Open System Settings</button>}
  </div>
}

function SetupVoice({ settings, input, output, sessionId, transcript, voices, busy, onUpdate, onVoice, onVoiceTest }: {
  settings: OmniSettings; input: OmniSpeechInputAvailability; output: OmniVoiceAvailability; sessionId: string | null
  transcript: string; voices: OmniInstalledVoice[]; busy: boolean
  onUpdate(changes: OmniSettingsChanges): Promise<OmniSettings | undefined>; onVoice(): void; onVoiceTest(): void
}) {
  return <div className="omni-setup-step"><div className="omni-setup-title"><span><Mic /></span><div><p className="omni-kicker">VOICE</p><h1>Make sure Omni can hear you</h1><p>Speech stays on this Mac. Test input and choose the voice Omni uses for spoken responses.</p></div></div>
    <div className={`omni-mic-test${sessionId ? ' listening' : ''}`}><button type="button" onClick={onVoice} disabled={busy || (!input.available && !sessionId)} aria-label={sessionId ? 'Stop microphone test' : 'Start microphone test'}>{sessionId ? <Square /> : <Mic />}</button>
      <span><strong>{sessionId ? 'Listening…' : input.available ? 'Microphone ready' : 'Voice input unavailable'}</strong><small>{transcript || input.reason || 'Say “Hey Omni, are you ready?”'}</small></span>
      <i aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <b key={index} />)}</i></div>
    <div className="omni-setup-fields"><label><span>Omni voice</span><select value={settings.voice.voiceId} disabled={busy || !output.available} onChange={(event) => void onUpdate({ voice: { voiceId: event.target.value } })}>
      <option value="">System Default</option>{voices.map((voice) => <option key={`${voice.id}-${voice.locale}`} value={voice.id}>{voice.name} · {voice.locale}</option>)}</select></label>
      <button type="button" className="omni-secondary-button" disabled={busy || !output.available} onClick={onVoiceTest}><Volume2 />Test Voice</button></div>
  </div>
}

function SetupAI({ settings, models, modelDraft, busy, onProvider, onModel }: {
  settings: OmniSettings; models: AIModel[]; modelDraft: string; busy: boolean
  onProvider(provider: AIProviderId): Promise<void>; onModel(modelId: string): void
}) {
  return <div className="omni-setup-step"><div className="omni-setup-title"><span><Bot /></span><div><p className="omni-kicker">INTELLIGENCE</p><h1>Choose Omni's AI</h1><p>Use the same local and cloud providers already configured in OmniCode.</p></div></div>
    <div className="omni-choice-grid omni-provider-choices">{PROVIDERS.map((provider) => <button type="button" key={provider.id} disabled={busy} className={settings.model.provider === provider.id ? 'selected' : ''} onClick={() => void onProvider(provider.id)}>
      <span>{provider.id === 'ollama' ? <MonitorCog /> : <Sparkles />}</span><strong>{provider.label}</strong><small>{provider.group}</small>{settings.model.provider === provider.id && <Check />}</button>)}</div>
    <label className="omni-wide-field"><span>Model</span><select value={modelDraft} disabled={busy || !models.length} onChange={(event) => onModel(event.target.value)}>
      {!models.length && <option value="">No available models detected</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
      <small>{models.length ? `${models.length} compatible model${models.length === 1 ? '' : 's'} available.` : 'Configure this provider in AI Provider settings or choose another provider.'}</small></label>
  </div>
}

function SetupExecution({ settings, cursorReady, busy, onUpdate, onApproval }: {
  settings: OmniSettings; cursorReady: boolean; busy: boolean
  onUpdate(changes: OmniSettingsChanges): Promise<OmniSettings | undefined>; onApproval(mode: WorkApprovalMode): Promise<void>
}) {
  return <div className="omni-setup-step"><div className="omni-setup-title"><span><Zap /></span><div><p className="omni-kicker">CONTROL</p><h1>Choose how Omni works</h1><p>Execution controls where actions happen. Approval controls when Omni must ask.</p></div></div>
    <h2>Execution</h2><div className="omni-choice-grid two-column"><Choice selected={settings.executionMode === 'invisible'} icon={<EyeOff />} title="Invisible · Recommended" detail="Perform supported tasks in the background." onClick={() => void onUpdate({ executionMode: 'invisible' })} />
      <Choice selected={settings.executionMode === 'cursor'} disabled={!cursorReady} icon={<MousePointer2 />} title="Cursor" detail={cursorReady ? `Visible Mac control · stop with ${OMNI_CURSOR_EMERGENCY_STOP_LABEL}.` : 'Accessibility and the native cursor helper are required.'} onClick={() => void onUpdate({ executionMode: 'cursor' })} /></div>
    <h2>Approvals</h2><div className="omni-choice-grid three-column"><Choice selected={settings.approvalMode === 'ask'} icon={<ShieldCheck />} title="Ask for approval" detail="Ask before changes and external actions." onClick={() => void onApproval('ask')} />
      <Choice selected={settings.approvalMode === 'auto'} icon={<Sparkles />} title="Approve for me" detail="Handle low-risk reversible work automatically." onClick={() => void onApproval('auto')} />
      <Choice selected={settings.approvalMode === 'full'} icon={<Zap />} title="Full access" detail="Maximum autonomy within protected boundaries." onClick={() => void onApproval('full')} /></div>
    {busy && <LoaderCircle className="omni-spin" />}
  </div>
}

function SetupActivation({ settings, busy, onUpdate }: { settings: OmniSettings; busy: boolean; onUpdate(changes: OmniSettingsChanges): Promise<OmniSettings | undefined> }) {
  return <div className="omni-setup-step"><div className="omni-setup-title"><span><AudioWaveform /></span><div><p className="omni-kicker">ACTIVATION</p><h1>Call Omni from anywhere</h1><p>Your global shortcut is registered when setup finishes. Wake phrase processing remains on-device.</p></div></div>
    <div className="omni-shortcut-card"><span><strong>Global shortcut</strong><small>Activate Omni</small></span><kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd></div>
    <label className="omni-setup-toggle"><span><strong>Enable “Hey Omni”</strong><small>Listen for the wake phrase using the local voice system.</small></span><input type="checkbox" disabled={busy} checked={settings.activation.voiceActivation === 'wake-word-and-shortcut'} onChange={(event) => void onUpdate({ activation: { voiceActivation: event.target.checked ? 'wake-word-and-shortcut' : 'shortcut-only' } })} /></label>
    <label className="omni-setup-toggle"><span><strong>Start Omni with my Mac</strong><small>Recommended for global activation and background availability.</small></span><input type="checkbox" disabled={busy} checked={settings.launchHelperAtLogin} onChange={(event) => void onUpdate({ launchHelperAtLogin: event.target.checked })} /></label>
  </div>
}

function SetupReady({ settings, permissions, cursorReady }: { settings: OmniSettings; permissions: OmniPermissionsSnapshot | null; cursorReady: boolean }) {
  const items = [
    ['Microphone', permissions?.permissions.microphone === 'granted'], ['Speech recognition', permissions?.permissions['speech-recognition'] === 'granted'],
    ['AI model', Boolean(settings.model.modelId)], ['Global shortcut', true], [`${settings.executionMode === 'cursor' ? 'Cursor' : 'Invisible'} Mode`, settings.executionMode !== 'cursor' || cursorReady], ['Approval settings', true],
  ] as const
  return <div className="omni-setup-ready"><div className="omni-ready-mark"><Check /></div><p className="omni-kicker">SETUP COMPLETE</p><h1>Omni is ready.</h1>
    <p>You can start now. Capabilities without macOS permission remain safely unavailable until you enable them.</p>
    <ul>{items.map(([label, ready]) => <li key={label} data-ready={ready}><span>{ready ? <Check /> : <CircleAlert />}</span>{label}<small>{ready ? 'Ready' : 'Needs attention'}</small></li>)}</ul>
  </div>
}

function Choice({ selected, disabled = false, icon, title, detail, onClick }: { selected: boolean; disabled?: boolean; icon: React.ReactNode; title: string; detail: string; onClick(): void }) {
  return <button type="button" className={selected ? 'selected' : ''} disabled={disabled} onClick={onClick}><span>{icon}</span><strong>{title}</strong><small>{detail}</small>{selected && <Check />}</button>
}

function OmniDashboard({
  active, settings, task, history, models, modelDraft, controllerAvailable, voiceInput, voiceOutput, voiceSessionId,
  requestText, cursorReady, busy, loading, error, historyOpen, onDismissError, onRetry, onProvider, onModel,
  onExecution, onApproval, onRequest, onStart, onVoice, onControl, onHistory, onCloseHistory, onSelectHistory
}: {
  active: boolean; settings: OmniSettings; task: OmniTask | null; history: OmniTaskSummary[]; models: AIModel[]; modelDraft: string
  controllerAvailable: boolean; voiceInput: OmniSpeechInputAvailability; voiceOutput: OmniVoiceAvailability; voiceSessionId: string | null
  requestText: string; cursorReady: boolean; busy: boolean; loading: boolean; error: PresentedError | null; historyOpen: boolean
  onDismissError(): void; onRetry(): void; onProvider(provider: AIProviderId): Promise<void>; onModel(model: string): void
  onExecution(mode: OmniExecutionMode): Promise<void>; onApproval(mode: WorkApprovalMode): Promise<void>; onRequest(value: string): void
  onStart(): void; onVoice(): void; onControl(action: 'pause' | 'resume' | 'stop'): void; onHistory(): void; onCloseHistory(): void
  onSelectHistory(id: string): void
}) {
  const taskRunning = Boolean(task && !isTerminalOmniStatus(task.status))
  const currentStatus: OmniStatus = voiceSessionId ? 'listening' : task?.status ?? 'idle'
  const state = settings.enabled
    ? omniStateCopy(currentStatus, task)
    : { title: 'Offline', detail: 'Enable Omni in Settings to accept new requests.' }
  const latestEvents = task?.events.slice(-ACTIVITY_LIMIT).reverse() ?? []
  const execution = taskRunning ? task?.executionMode : settings.executionMode
  return <section className="omni-mode omni-dashboard" data-active={active} data-state={currentStatus} aria-label="Omni mode">
    <header className="omni-command-bar"><div className="omni-command-identity"><span><AudioWaveform /></span><div><strong>Omni</strong><small>Voice-first AI assistant</small></div></div>
      <div className="omni-command-controls" aria-label="Omni operating settings">
        <label><span>Provider</span><select value={settings.model.provider} disabled={busy} onChange={(event) => void onProvider(event.target.value as AIProviderId)}>{PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
        <label><span>Model</span><select value={modelDraft} disabled={busy || !models.length} onChange={(event) => onModel(event.target.value)}>{!models.length && <option value="">No models</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
        <label><span>Execution</span><select value={execution} disabled={busy} onChange={(event) => void onExecution(event.target.value as OmniExecutionMode)}><option value="invisible">Invisible</option><option value="cursor" disabled={!cursorReady}>{cursorReady ? 'Cursor' : 'Cursor unavailable'}</option></select></label>
        <label><span>Approvals</span><select value={displayedOmniApprovalMode(settings.approvalMode, task)} disabled={busy || taskRunning} onChange={(event) => void onApproval(event.target.value as WorkApprovalMode)}><option value="ask">Always ask</option><option value="auto">Ask when needed</option><option value="full">Full access</option></select></label>
      </div></header>

    {error && <OmniAlert error={error} onDismiss={onDismissError} onRetry={onRetry} />}

    <div className="omni-dashboard-grid">
      <aside className="omni-context-column">
        <section className="omni-holo-panel omni-identity-card"><div className="omni-identity-emblem"><AudioWaveform /></div><p className="omni-kicker">OMNICODE</p><h2>Omni</h2><p>Your voice-first assistant that gets things done.</p>
          <div className="omni-online-state" data-online={controllerAvailable}><span />{controllerAvailable ? 'Controller online' : 'Controller unavailable'}</div>
          <ul><li><Code2 /><span><strong>Code</strong><small>Write, refactor, and debug</small></span></li><li><FolderSync /><span><strong>Work</strong><small>Research, plan, and execute</small></span></li><li><WandSparkles /><span><strong>Automate</strong><small>Use approved tools safely</small></span></li><li><Mic /><span><strong>Voice-first</strong><small>Just talk. Omni handles the rest.</small></span></li></ul>
        </section>
        <section className="omni-holo-panel omni-current-card"><div className="omni-panel-label"><FileText />Current task{task && <span className={`status-${task.status}`}>{humanizeOmniStatus(task.status)}</span>}</div>
          {task ? <><h3>{task.title}</h3><dl><div><dt>Model</dt><dd>{task.model}</dd></div><div><dt>Execution</dt><dd>{task.executionMode}</dd></div><div><dt>Actions</dt><dd>{task.actionCount}</dd></div></dl>
            {task.error && <p className="omni-compact-error">{presentOmniError(task.error).message}</p>}
            {taskRunning && <div className="omni-task-controls">{task.status === 'paused' ? <button onClick={() => onControl('resume')}><Play />Resume</button> : <button disabled={!PAUSABLE_STATUSES.has(task.status)} onClick={() => onControl('pause')}><Pause />Pause</button>}<button onClick={() => onControl('stop')}><Square />Stop</button></div>}</>
            : <div className="omni-panel-empty"><Sparkles /><strong>No active task</strong><small>Activate Omni when you're ready.</small></div>}
        </section>
      </aside>

      <main className="omni-core-column">
        <section className={`omni-core-stage status-${currentStatus}`} aria-labelledby="omni-core-state"><p className="omni-core-motto">LISTEN <i /> THINK <i /> TAKE ACTION</p>
          <div className="omni-wave-line omni-wave-left" aria-hidden="true" /><div className="omni-wave-line omni-wave-right" aria-hidden="true" />
          <div className="omni-core" aria-hidden="true"><span className="omni-core-glow" /><span className="omni-core-orbit orbit-one" /><span className="omni-core-orbit orbit-two" /><span className="omni-core-orbit orbit-three" />
            <span className="omni-core-ticks" /><span className="omni-core-center">{busy || ['planning', 'transcribing', 'working'].includes(currentStatus) ? <LoaderCircle /> : <AudioWaveform />}</span></div>
          <div className="omni-core-copy" role="status" aria-live="polite"><span>OMNI</span><h1 id="omni-core-state">{state.title}</h1><p>{state.detail}</p></div>
          <div className="omni-core-signals"><span data-ready={voiceInput.available}><Mic />{voiceSessionId ? 'Listening now' : voiceInput.available ? 'Voice input ready' : 'Voice needs attention'}</span>
            <span data-ready={voiceOutput.available}><Sparkles />{voiceOutput.available ? 'On-device speech' : 'Speech unavailable'}</span>
            <span data-ready={execution === 'invisible' || cursorReady}>{execution === 'cursor' ? <MousePointer2 /> : <Zap />}{execution === 'cursor' ? 'Cursor mode' : 'Invisible mode'}</span></div>
        </section>

        <section className={`omni-voice-dock${voiceSessionId ? ' listening' : ''}${settings.showTextInput && !voiceSessionId ? ' has-text-input' : ''}`} aria-label="Voice activation">
          <div className="omni-voice-hint"><AudioWaveform /><span>Press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd><small>to activate Omni</small></span></div>
          <button type="button" className="omni-mic-button" disabled={!settings.enabled || busy || taskRunning || (!voiceInput.available && !voiceSessionId)} title={!settings.enabled ? 'Enable Omni in Settings to use voice input.' : voiceInput.reason} onClick={onVoice} aria-label={voiceSessionId ? 'Stop listening and send request' : 'Start voice request'}>{voiceSessionId ? <Square /> : <Mic />}</button>
          <div className="omni-voice-hint align-right"><span>Or just say<strong>“Hey Omni”</strong></span><AudioWaveform /></div>
          {voiceSessionId && <p className="omni-live-transcript">{requestText || 'Listening…'}</p>}
          {settings.showTextInput && !voiceSessionId && <form className="omni-compact-composer" onSubmit={(event) => { event.preventDefault(); onStart() }}><input value={requestText} onChange={(event) => onRequest(event.target.value)} placeholder="Type an Omni request…" disabled={!settings.enabled || taskRunning || busy} /><button type="submit" disabled={!settings.enabled || !requestText.trim() || taskRunning || busy || !modelDraft}><Send /></button></form>}
        </section>
      </main>

      <aside className="omni-activity-column"><section className="omni-holo-panel omni-activity-panel"><header><span><Activity /></span><div><p className="omni-kicker">ACTIVITY</p><h2>Live AI assistant events</h2></div><button type="button" onClick={onHistory}><History />Previous tasks</button></header>
        {latestEvents.length ? <ol className="omni-timeline" aria-live="polite">{latestEvents.map((event) => <EventItem key={event.id} event={event} />)}</ol> : <div className="omni-activity-empty"><Sparkles /><strong>Ready for your next request</strong><p>Tool actions and concise results appear here as Omni works.</p></div>}
        <footer><span data-online={controllerAvailable} /><small>{loading ? 'Refreshing systems…' : controllerAvailable ? 'Omni operational' : 'Controller unavailable'}</small><em>PRIVATE · CAPABLE</em></footer>
      </section></aside>
    </div>

    <footer className="omni-dashboard-footer"><span><AudioWaveform />OmniCode</span><small>v0.5.1</small><i /><span data-ready={controllerAvailable}><b />Omni {controllerAvailable ? 'ready' : 'offline'}</span><small>Do more with your voice.</small></footer>
    {historyOpen && <PreviousTasks tasks={history} onClose={onCloseHistory} onSelect={onSelectHistory} />}
  </section>
}

function OmniAlert({ error, onDismiss, onRetry }: { error: PresentedError; onDismiss(): void; onRetry?: () => void }) {
  return <div className="omni-alert" role="alert"><span><CircleAlert /></span><div><strong>{error.title}</strong><p>{error.message}</p><details><summary>Technical details</summary><pre>{error.detail}</pre></details></div>
    {onRetry && <button type="button" onClick={onRetry}><RefreshCw />Try again</button>}<button type="button" className="omni-alert-close" onClick={onDismiss} aria-label="Dismiss"><X /></button></div>
}

function EventItem({ event }: { event: OmniEvent }) {
  const icon = event.status === 'succeeded' ? <CheckCircle2 /> : event.status === 'failed' ? <XCircle />
    : event.status === 'running' ? <LoaderCircle className="omni-spin" /> : event.kind === 'terminal' ? <Terminal />
      : event.kind === 'browser' ? <MonitorCog /> : event.kind === 'file' ? <FileText /> : <Activity />
  const source = event.connectorId ?? event.toolId?.split('.')[0] ?? event.kind
  return <li data-status={event.status}><span className="omni-timeline-icon">{icon}</span><div><header><strong>{source}</strong><time>{formatTimestamp(event.timestamp)}</time></header><h3>{event.title}</h3><p>{event.summary}</p>
    {event.output && <details><summary>View output</summary><pre>{event.output}</pre></details>}</div></li>
}

function PreviousTasks({ tasks, onClose, onSelect }: { tasks: OmniTaskSummary[]; onClose(): void; onSelect(id: string): void }) {
  return <div className="omni-history-backdrop" role="dialog" aria-modal="true" aria-label="Previous Omni tasks"><section className="omni-history-drawer"><header><div><p className="omni-kicker">ACTIVITY ARCHIVE</p><h2>Previous Tasks</h2></div><button type="button" onClick={onClose} aria-label="Close previous tasks"><X /></button></header>
    {tasks.length ? <ol>{tasks.map((entry) => <li key={entry.id}><button type="button" onClick={() => onSelect(entry.id)}><span><strong>{entry.title}</strong><small>{entry.provider} · {entry.model} · {formatFullTimestamp(entry.updatedAt)}</small></span><em className={`status-${entry.status}`}>{humanizeOmniStatus(entry.status)}</em></button></li>)}</ol>
      : <div className="omni-panel-empty"><Clock3 /><strong>No previous tasks</strong><small>Completed Omni tasks will appear here.</small></div>}
  </section></div>
}

function omniStateCopy(status: OmniStatus, task: OmniTask | null): { title: string; detail: string } {
  const latest = task?.events.at(-1)?.summary
  switch (status) {
    case 'listening': return { title: 'Listening…', detail: 'Speak naturally. Omni is listening on this Mac.' }
    case 'transcribing': return { title: 'Understanding…', detail: 'Turning your voice into a request.' }
    case 'planning': return { title: 'Thinking…', detail: latest ?? 'Preparing the safest course of action.' }
    case 'waiting-for-approval': return { title: 'Approval needed', detail: latest ?? 'Review the requested action to continue.' }
    case 'working': return { title: 'Working', detail: latest ?? task?.title ?? 'Omni is carrying out your request.' }
    case 'using-cursor': return { title: 'Cursor Control Active', detail: `Visible control is active. Stop anytime with ${OMNI_CURSOR_EMERGENCY_STOP_LABEL}.` }
    case 'speaking': return { title: 'Speaking', detail: task?.resultSummary ?? 'Omni is responding.' }
    case 'paused': return { title: 'Paused', detail: 'Your task is safely paused.' }
    case 'completed': return { title: 'Complete', detail: task?.resultSummary ?? 'The task finished successfully.' }
    case 'failed': return { title: 'Needs attention', detail: task?.error ? presentOmniError(task.error).message : 'The task could not be completed.' }
    case 'stopped': return { title: 'Stopped', detail: 'The task was stopped.' }
    default: return { title: 'Ready', detail: 'Say the word. I’m listening.' }
  }
}

function permissionStateLabel(state: OmniPermissionState): string {
  if (state === 'granted') return 'Enabled'
  if (state === 'not-determined') return 'Not enabled'
  if (state === 'unavailable') return 'Unavailable'
  return state[0].toUpperCase() + state.slice(1)
}

function formatTimestamp(timestamp: number): string {
  try { return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(timestamp) } catch { return 'Now' }
}

function formatFullTimestamp(timestamp: number): string {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp) } catch { return 'Unknown time' }
}
