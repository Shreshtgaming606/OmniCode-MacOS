import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AudioWaveform,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  EyeOff,
  ListChecks,
  LoaderCircle,
  Mic,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  SkipForward,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react'

import type { AIModel, AIProviderId, OmniSettingsChanges } from '../../../../shared/contracts'
import type { CloudAIProviderId } from '../../../../shared/model-contracts'
import type {
  OmniEvent,
  OmniExecutionMode,
  OmniInstalledVoice,
  OmniPermissionId,
  OmniPermissionsSnapshot,
  OmniSettings,
  OmniStatus,
  OmniTask,
  OmniTaskSummary,
  OmniVoiceAvailability,
} from '../../../../shared/omni-contracts'
import type { WorkApprovalMode } from '../../../../shared/tool-contracts'
import type { OmniCursorPermissionStatus } from '../../../../shared/omni-cursor-contracts'
import './OmniMode.css'

const TERMINAL_STATUSES = new Set<OmniStatus>(['completed', 'failed', 'stopped'])
const PAUSABLE_STATUSES = new Set<OmniStatus>([
  'listening', 'transcribing', 'planning', 'waiting-for-approval', 'working', 'using-cursor', 'speaking'
])
const PROVIDERS: Array<{ id: AIProviderId; label: string }> = [
  { id: 'ollama', label: 'Ollama · local' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'google', label: 'Google Gemini' },
]
const PERMISSIONS: Array<{ id: OmniPermissionId; label: string }> = [
  { id: 'microphone', label: 'Microphone' },
  { id: 'speech-recognition', label: 'Speech recognition' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'screen-recording', label: 'Screen recording' },
]

async function fetchOmniModels(provider: AIProviderId): Promise<AIModel[]> {
  if (provider === 'ollama') return window.omnicode.ai.models()
  const result = await window.omnicode.ai.cloudModelCatalog(provider as CloudAIProviderId, {})
  return result.models
    .filter((model) => model.availability !== 'unavailable' && model.capabilities.chat.support !== 'unsupported')
    .map((model) => ({
      id: model.id,
      name: model.displayName,
      provider: model.provider,
      local: false,
      description: model.description,
      contextWindow: model.contextWindow,
      capabilities: Object.entries(model.capabilities)
        .filter(([, capability]) => capability.support === 'supported')
        .map(([name]) => name),
      toolUse: model.capabilities['tool-calling'].support === 'supported'
    }))
}

export function isTerminalOmniStatus(status: OmniStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

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
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{20,})\b/gu, '[REDACTED]')
    .replace(/((?:api|access|refresh)[_-]?(?:key|token)\s*[:=]\s*)[^\s,;}]+/giu, '$1[REDACTED]')
    .slice(0, 1_000)
}

export function OmniMode({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<OmniSettings | null>(null)
  const [history, setHistory] = useState<OmniTaskSummary[]>([])
  const [task, setTask] = useState<OmniTask | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<OmniPermissionsSnapshot | null>(null)
  const [models, setModels] = useState<AIModel[]>([])
  const [voiceOutput, setVoiceOutput] = useState<OmniVoiceAvailability>({ available: false, reason: 'Checking macOS speech output…' })
  const [cursorStatus, setCursorStatus] = useState<OmniCursorPermissionStatus>({
    accessibility: 'unavailable', nativeHelper: 'unavailable', checkedAt: 0
  })
  const [installedVoices, setInstalledVoices] = useState<OmniInstalledVoice[]>([])
  const [requestText, setRequestText] = useState('')
  const [lastSubmittedText, setLastSubmittedText] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [planInstruction, setPlanInstruction] = useState('')
  const [controllerAvailable, setControllerAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshTask = useCallback(async (taskId: string) => {
    const next = await window.omnicode.omni.tasks.get(taskId)
    setTask(next)
    setSelectedTaskId(next.id)
    return next
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextSettings, tasks, nextPermissions, nextVoiceOutput, nextVoices, nextCursorStatus] = await Promise.all([
        window.omnicode.omni.settings.get(),
        window.omnicode.omni.tasks.list(),
        window.omnicode.omni.permissions.status(),
        window.omnicode.omni.voice.availability().catch(() => ({ available: false, reason: 'macOS speech output is unavailable.' })),
        window.omnicode.omni.voice.voices().catch(() => [] as OmniInstalledVoice[]),
        window.omnicode.omni.cursor.status().catch(() => ({
          accessibility: 'unavailable' as const, nativeHelper: 'unavailable' as const, checkedAt: Date.now()
        })),
      ])
      setSettings(nextSettings)
      setModelDraft(nextSettings.model.modelId)
      setHistory(tasks)
      setPermissions(nextPermissions)
      setModels(await fetchOmniModels(nextSettings.model.provider).catch(() => []))
      setVoiceOutput(nextVoiceOutput)
      setInstalledVoices(nextVoices)
      setCursorStatus(nextCursorStatus)
      setControllerAvailable(true)

      const current = tasks.find((candidate) => !isTerminalOmniStatus(candidate.status)) ?? tasks[0]
      if (current) await refreshTask(current.id)
      else {
        setTask(null)
        setSelectedTaskId(null)
      }
    } catch (cause) {
      setControllerAvailable(false)
      setError(humanizeOmniError(cause))
    } finally {
      setLoading(false)
    }
  }, [refreshTask])

  useEffect(() => {
    void load()

    const unsubscribeSettings = window.omnicode.omni.settings.onChanged((next) => {
      setSettings(next)
      setModelDraft(next.model.modelId)
      setControllerAvailable(true)
      void fetchOmniModels(next.model.provider).then(setModels).catch(() => setModels([]))
    })
    const unsubscribeTask = window.omnicode.omni.tasks.onTaskChanged((changed) => {
      setHistory((current) => {
        const next = [changed, ...current.filter((candidate) => candidate.id !== changed.id)]
        return next.sort((left, right) => right.updatedAt - left.updatedAt)
      })
      setSelectedTaskId((currentId) => {
        if (currentId === changed.id || !isTerminalOmniStatus(changed.status)) {
          void refreshTask(changed.id).catch((cause) => setError(humanizeOmniError(cause)))
          return changed.id
        }
        return currentId
      })
    })
    const unsubscribeEvent = window.omnicode.omni.tasks.onEvent((event) => {
      setTask((current) => {
        if (!current || current.id !== event.taskId) return current
        const events = [...current.events.filter((candidate) => candidate.id !== event.id), event]
          .sort((left, right) => left.timestamp - right.timestamp)
        return { ...current, events }
      })
    })

    return () => {
      unsubscribeSettings()
      unsubscribeTask()
      unsubscribeEvent()
    }
  }, [load, refreshTask])

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await operation()
    } catch (cause) {
      setError(humanizeOmniError(cause))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])

  const updateSettings = useCallback(async (changes: OmniSettingsChanges, acknowledgeFullAccess = false) => {
    const next = await run(() => window.omnicode.omni.settings.update(changes, acknowledgeFullAccess))
    if (next) {
      setSettings(next)
      setModelDraft(next.model.modelId)
    }
    return next
  }, [run])

  const changeApprovalMode = useCallback(async (mode: WorkApprovalMode) => {
    if (mode === 'full') {
      const acknowledged = window.confirm(
        'Full Access lets Omni perform supported actions without asking each time. It does not bypass macOS permissions, workspace boundaries, or blocked dangerous operations. Enable Full Access?'
      )
      if (!acknowledged) return
      await updateSettings({ approvalMode: mode }, true)
      return
    }
    await updateSettings({ approvalMode: mode })
  }, [updateSettings])

  const changeExecutionMode = useCallback(async (mode: OmniExecutionMode) => {
    if (task && !isTerminalOmniStatus(task.status)) {
      const next = await run(() => window.omnicode.omni.tasks.switchExecutionMode(task.id, mode))
      if (next) setTask(next)
      return
    }
    await updateSettings({ executionMode: mode })
  }, [run, task, updateSettings])

  const startTask = useCallback(async () => {
    if (!settings || !settings.enabled) return
    const input = requestText.trim()
    if (!input) return
    const requestedModel = modelDraft.trim()
    if (!requestedModel) {
      setError('Choose a model before starting an Omni task.')
      return
    }
    let taskSettings = settings
    if (requestedModel !== settings.model.modelId) {
      const updated = await updateSettings({ model: { modelId: requestedModel } })
      if (!updated) return
      taskSettings = updated
    }
    const started = await run(() => window.omnicode.omni.tasks.start({
      provider: taskSettings.model.provider,
      model: taskSettings.model.modelId,
      input,
      activationSource: 'main-window',
      executionMode: taskSettings.executionMode,
      approvalMode: taskSettings.approvalMode,
    }))
    if (!started) return
    setTask(started)
    setSelectedTaskId(started.id)
    setHistory((current) => [started, ...current.filter((candidate) => candidate.id !== started.id)])
    setLastSubmittedText(input)
    setRequestText('')
  }, [modelDraft, requestText, run, settings, updateSettings])

  const controlTask = useCallback(async (action: 'pause' | 'resume' | 'stop') => {
    if (!task) return
    const next = await run(() => window.omnicode.omni.tasks[action](task.id))
    if (next) setTask(next)
  }, [run, task])

  const modifyPlan = useCallback(async () => {
    if (!task || !planInstruction.trim()) return
    const next = await run(() => window.omnicode.omni.tasks.modifyPlan(task.id, planInstruction.trim()))
    if (next) {
      setTask(next)
      setPlanInstruction('')
    }
  }, [planInstruction, run, task])

  const skipStep = useCallback(async () => {
    if (!task) return
    const next = await run(() => window.omnicode.omni.tasks.skipStep(task.id))
    if (next) setTask(next)
  }, [run, task])

  const selectHistory = useCallback((taskId: string) => {
    const running = history.find((candidate) => !isTerminalOmniStatus(candidate.status))
    if (running && running.id !== taskId) {
      setError('Finish or stop the active Omni task before inspecting another task.')
      return
    }
    setSelectedTaskId(taskId)
    setLastSubmittedText('')
    setError(null)
    void refreshTask(taskId).catch((cause) => setError(humanizeOmniError(cause)))
  }, [history, refreshTask])

  const clearHistory = useCallback(async () => {
    if (!window.confirm('Clear completed Omni task history? Active tasks are not deleted.')) return
    const cleared = await run(async () => {
      await window.omnicode.omni.tasks.clearHistory()
      return true
    })
    if (!cleared) return
    const tasks = await window.omnicode.omni.tasks.list().catch(() => [])
    setHistory(tasks)
    if (task && isTerminalOmniStatus(task.status)) {
      setTask(null)
      setSelectedTaskId(null)
    }
  }, [run, task])

  const providerModels = useMemo(() => {
    if (!settings) return []
    return models.filter((model) => model.provider === settings.model.provider)
  }, [models, settings])
  const currentStatus = task?.status ?? 'idle'
  const taskRunning = Boolean(task && !isTerminalOmniStatus(task.status))
  const cursorReady = cursorStatus.accessibility === 'granted' && cursorStatus.nativeHelper === 'available'
  const latestEvents = task?.events.slice(-30).reverse() ?? []

  return <section className="omni-mode" data-active={active} aria-label="Omni mode">
    <header className="omni-mode-header">
      <div className="omni-mode-identity">
        <span className="omni-mode-identity-icon" aria-hidden="true"><AudioWaveform /></span>
        <span><strong>Omni</strong><small>System assistant · controller-backed</small></span>
      </div>
      <div className="omni-mode-controls" aria-label="Omni preferences">
        <label className="omni-enable-control">
          <input type="checkbox" checked={settings?.enabled ?? false} disabled={!settings || busy || taskRunning}
            onChange={(event) => void updateSettings({ enabled: event.target.checked })} />
          <span>Enabled</span>
        </label>
        <label><span>Execution</span><select value={taskRunning ? task?.executionMode : settings?.executionMode ?? 'invisible'}
          onChange={(event) => void changeExecutionMode(event.target.value as OmniExecutionMode)}
          disabled={!settings || busy} aria-describedby="omni-availability-note">
          <option value="invisible">Invisible</option>
          <option value="cursor" disabled={!cursorReady}>{cursorReady ? 'Cursor' : 'Cursor · permission or helper required'}</option>
        </select></label>
        <label><span>Approvals</span><select value={displayedOmniApprovalMode(settings?.approvalMode, task)}
          onChange={(event) => void changeApprovalMode(event.target.value as WorkApprovalMode)}
          disabled={!settings || busy || taskRunning}>
          <option value="ask">Always ask</option>
          <option value="auto">Ask when needed</option>
          <option value="full">Full access</option>
        </select></label>
      </div>
    </header>

    {error && <div className="omni-mode-notice omni-mode-error" role="alert">
      <CircleAlert aria-hidden="true" /><span><strong>Omni request failed.</strong> {error}</span>
      <button type="button" onClick={() => setError(null)} aria-label="Dismiss Omni error">Dismiss</button>
    </div>}
    {!error && <div className="omni-mode-notice" id="omni-availability-note" role="status">
      {loading ? <LoaderCircle className="omni-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
      <span>{loading
        ? <><strong>Connecting to the Omni controller.</strong> Loading settings and task history…</>
        : <><strong>{controllerAvailable ? 'Omni controller available.' : 'Omni controller unavailable.'}</strong> Typed requests and macOS spoken responses work now; voice input is not connected yet{cursorReady ? ', and structured Cursor Mode is ready.' : ', while Cursor Mode still needs its helper and Accessibility permission.'}</>}
      </span>
    </div>}

    <div className="omni-mode-workspace">
      <aside className="omni-mode-rail" aria-label="Omni task and plan">
        <section className="omni-panel">
          <PanelHeading icon={<AudioWaveform />} title="Current task" subtitle="Controller-verified state" />
          {task ? <div className="omni-current-task">
            <span className={`omni-status-pill status-${task.status}`}>{humanizeOmniStatus(task.status)}</span>
            <strong>{task.title}</strong>
            <dl>
              <div><dt>Model</dt><dd>{task.provider} · {task.model}</dd></div>
              <div><dt>Execution</dt><dd>{task.executionMode}</dd></div>
              <div><dt>Actions</dt><dd>{task.actionCount}</dd></div>
            </dl>
            {task.error && <p className="omni-task-error">{task.error}</p>}
          </div> : <EmptyState eyebrow="Idle" title="No task selected">Submit a typed request or select a task from history.</EmptyState>}
        </section>
        <section className="omni-panel">
          <PanelHeading icon={<ListChecks />} title="Course of action" subtitle="Plan and progress summary" />
          {task?.plan ? <div className="omni-plan">
            <p className="omni-plan-understanding">{task.plan.taskUnderstanding}</p>
            <p>{task.plan.reasoningSummary}</p>
            <ol>
              {task.plan.steps.map((step) => <li key={step.id} data-status={step.status}>
                <span aria-hidden="true">{step.status === 'completed' ? <Check /> : step.status === 'skipped' ? <SkipForward /> : <span />}</span>
                <span><strong>{step.title}</strong><small>{step.status}</small></span>
              </li>)}
            </ol>
            {taskRunning && <div className="omni-plan-actions">
              <label htmlFor="omni-plan-instruction">Change the plan</label>
              <textarea id="omni-plan-instruction" value={planInstruction}
                onChange={(event) => setPlanInstruction(event.target.value)}
                placeholder="Describe the adjustment…" maxLength={1_000} rows={2} disabled={busy} />
              <div><button type="button" onClick={() => void modifyPlan()} disabled={busy || !planInstruction.trim()}><Pencil />Modify</button>
                <button type="button" onClick={() => void skipStep()} disabled={busy}><SkipForward />Skip current</button></div>
            </div>}
          </div> : <EmptyState title="No active plan" compact>The controller has not proposed a plan for this task.</EmptyState>}
        </section>
      </aside>

      <main className="omni-mode-center">
        <section className={`omni-orb-stage status-${currentStatus}`} aria-labelledby="omni-state-heading">
          <div className="omni-orb" aria-hidden="true">
            <span className="omni-orb-halo" />
            <span className="omni-orb-ring omni-orb-ring-outer" />
            <span className="omni-orb-ring omni-orb-ring-inner" />
            <span className="omni-orb-core">{busy ? <LoaderCircle className="omni-spin" /> : <AudioWaveform />}</span>
          </div>
          <div className="omni-orb-copy" role="status" aria-live="polite">
            <span>Omni state</span><h1 id="omni-state-heading">{humanizeOmniStatus(currentStatus)}</h1>
            <p>{task ? task.title : settings?.enabled ? 'Ready for a typed request' : 'Enable Omni to start'}</p>
          </div>
          <div className="omni-orb-badges" aria-label="Omni availability summary">
            <span><Mic aria-hidden="true" />Voice input unavailable</span>
            <span><AudioWaveform aria-hidden="true" />{voiceOutput.available ? 'Spoken output ready' : 'Spoken output unavailable'}</span>
            <span><MousePointer2 aria-hidden="true" />{cursorReady ? 'Structured cursor ready' : 'Native cursor unavailable'}</span>
          </div>
        </section>

        <section className="omni-conversation" aria-label="Omni request and response">
          <div className="omni-conversation-card">
            <div className="omni-conversation-label"><Mic aria-hidden="true" />Latest request</div>
            <strong>{lastSubmittedText ? 'Typed request' : 'No request in this session'}</strong>
            <p>{lastSubmittedText || 'Full request text stays in the live session; history keeps only a short redacted title and plan summary.'}</p>
          </div>
          <div className="omni-conversation-card">
            <div className="omni-conversation-label"><AudioWaveform aria-hidden="true" />Omni result</div>
            <strong>{task?.resultSummary ? 'Result' : 'No result yet'}</strong>
            <p>{task?.resultSummary ?? (taskRunning ? 'The controller is working on this task.' : 'Start or select a completed task to see its result.')}</p>
          </div>
        </section>

        <section className="omni-composer" aria-label="Start an Omni task">
          <label htmlFor="omni-request">Typed request <span>Voice transcription is not available yet</span></label>
          <div>
            <textarea id="omni-request" value={requestText} onChange={(event) => setRequestText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void startTask()
                }
              }}
              rows={2} maxLength={16_384} placeholder="Ask Omni to work across your connected tools…"
              disabled={!settings?.enabled || taskRunning || busy} />
            <button type="button" className="omni-send" onClick={() => void startTask()}
              disabled={!settings?.enabled || taskRunning || busy || !requestText.trim() || !modelDraft.trim()}
              aria-label="Start typed Omni task"><Send /></button>
          </div>
          {!settings?.enabled && <small>Omni is off. Enable it in the header before starting a task.</small>}
          {settings?.enabled && !modelDraft.trim() && <small>Choose a provider and model below before starting a task.</small>}
        </section>

        <div className="omni-execution-bar" aria-label="Omni execution controls">
          <button type="button" disabled title="Speech-to-text is not connected"><Mic />Voice unavailable</button>
          {task?.status === 'paused'
            ? <button type="button" disabled={busy} onClick={() => void controlTask('resume')}><Play />Resume</button>
            : <button type="button" disabled={!task || !PAUSABLE_STATUSES.has(task.status) || busy} onClick={() => void controlTask('pause')}><Pause />Pause</button>}
          <button type="button" disabled={!taskRunning || busy} onClick={() => void controlTask('stop')}><Square />Stop</button>
        </div>

        <section className="omni-model-settings" aria-label="Omni model settings">
          <label>Provider<select value={settings?.model.provider ?? 'ollama'} disabled={!settings || busy}
            onChange={(event) => void updateSettings({ model: { provider: event.target.value as AIProviderId, modelId: '' } })}>
            {PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select></label>
          <label>Model<input value={modelDraft} list="omni-model-options" maxLength={256} disabled={!settings || busy}
            placeholder={providerModels.length ? 'Choose or enter a model' : 'Enter a configured model ID'}
            onChange={(event) => setModelDraft(event.target.value)}
            onBlur={() => {
              if (settings && modelDraft.trim() !== settings.model.modelId) {
                void updateSettings({ model: { modelId: modelDraft.trim() } })
              }
            }} /></label>
          <datalist id="omni-model-options">{providerModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
          <label>Spoken responses<select value={settings?.voice.spokenResponses ? 'on' : 'off'} disabled={!settings || busy || !voiceOutput.available}
            onChange={(event) => void updateSettings({ voice: { spokenResponses: event.target.value === 'on' } })}>
            <option value="on">On</option><option value="off">Off</option>
          </select></label>
          <label>macOS voice<select value={settings?.voice.voiceId ?? ''} disabled={!settings || busy || !voiceOutput.available}
            onChange={(event) => void updateSettings({ voice: { voiceId: event.target.value } })}>
            <option value="">System default</option>
            {installedVoices.map((voice) => <option key={`${voice.id}-${voice.locale}`} value={voice.id}>{voice.name} · {voice.locale}</option>)}
          </select></label>
          <button type="button" onClick={() => void load()} disabled={loading || busy} aria-label="Refresh Omni settings and models"><RefreshCw />Refresh</button>
        </section>
      </main>

      <aside className="omni-mode-rail" aria-label="Omni activity and history">
        <section className="omni-panel">
          <PanelHeading icon={<Activity />} title="Activity" subtitle="Live controller events" />
          {latestEvents.length ? <ol className="omni-event-list" aria-live="polite">
            {latestEvents.map((event) => <EventItem key={event.id} event={event} />)}
          </ol> : <EmptyState title="No activity yet" compact>No controller action has been recorded for this task.</EmptyState>}
        </section>
        <section className="omni-panel">
          <div className="omni-heading-row">
            <PanelHeading icon={<Clock3 />} title="History" subtitle="Recent Omni tasks" />
            <button type="button" onClick={() => void clearHistory()} disabled={!history.length || busy} aria-label="Clear Omni history"><Trash2 /></button>
          </div>
          {history.length ? <ol className="omni-history-list">
            {history.map((entry) => <li key={entry.id}>
              <button type="button" className={selectedTaskId === entry.id ? 'selected' : ''} onClick={() => selectHistory(entry.id)}>
                <span><strong>{entry.title}</strong><small>{formatTimestamp(entry.updatedAt)}</small></span>
                <span className={`omni-history-status status-${entry.status}`}>{humanizeOmniStatus(entry.status)}</span>
              </button>
            </li>)}
          </ol> : <EmptyState title="No Omni tasks yet" compact>Completed and interrupted tasks will appear here.</EmptyState>}
        </section>
        <section className="omni-panel omni-availability">
          <PanelHeading icon={<ShieldCheck />} title="Availability" subtitle="Real service state" />
          <ul>
            <Availability label="Omni controller" state={controllerAvailable ? 'granted' : 'unavailable'}>
              {controllerAvailable ? 'Connected to the main-process controller' : 'Backend connection unavailable'}
            </Availability>
            <Availability label="Voice input" state="unavailable">Speech-to-text bridge not connected</Availability>
            <Availability label="Spoken output" state={voiceOutput.available ? 'granted' : 'unavailable'}>
              {voiceOutput.available ? 'macOS speech synthesis is available' : voiceOutput.reason ?? 'macOS speech synthesis is unavailable'}
            </Availability>
            <Availability label="Native cursor control" state="unavailable">Native accessibility bridge not connected</Availability>
            {PERMISSIONS.map(({ id, label }) => <Availability key={id} label={label} state={permissions?.permissions[id] ?? 'not-determined'}>
              <button type="button" onClick={() => void run(() => window.omnicode.omni.permissions.openSettings(id))}>Open settings</button>
            </Availability>)}
          </ul>
          <div className="omni-availability-mode">
            {(taskRunning ? task?.executionMode : settings?.executionMode) === 'cursor' ? <MousePointer2 aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
            {(taskRunning ? task?.executionMode : settings?.executionMode) === 'cursor' ? 'Cursor' : 'Invisible'} mode selected
          </div>
        </section>
      </aside>
    </div>
  </section>
}

function PanelHeading({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return <div className="omni-panel-heading">
    <span className="omni-panel-icon" aria-hidden="true">{icon}</span>
    <div><h2>{title}</h2><p>{subtitle}</p></div>
  </div>
}

function EmptyState({ eyebrow, title, compact = false, children }: {
  eyebrow?: string
  title: string
  compact?: boolean
  children: React.ReactNode
}) {
  return <div className={`omni-empty-state${compact ? ' compact' : ''}`}>
    {eyebrow && <span className="omni-empty-eyebrow">{eyebrow}</span>}
    <strong>{title}</strong><p>{children}</p>
  </div>
}

function Availability({ label, state, children }: {
  label: string
  state: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unavailable'
  children: React.ReactNode
}) {
  return <li data-state={state}><span className="omni-availability-dot" aria-hidden="true" /><span>
    <strong>{label}<em>{state.replace('-', ' ')}</em></strong><small>{children}</small>
  </span></li>
}

function EventItem({ event }: { event: OmniEvent }) {
  const icon = event.status === 'succeeded' ? <CheckCircle2 /> : event.status === 'failed' ? <XCircle />
    : event.status === 'running' ? <LoaderCircle className="omni-spin" /> : <Activity />
  return <li data-status={event.status}>
    <span aria-hidden="true">{icon}</span>
    <div><strong>{event.title}</strong><p>{event.summary}</p>
      {event.output && <pre>{event.output}</pre>}
      <small>{formatTimestamp(event.timestamp)}</small>
    </div>
  </li>
}

function formatTimestamp(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(timestamp)
  } catch {
    return 'Unknown time'
  }
}
