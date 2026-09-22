import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AudioWaveform, ExternalLink, LoaderCircle, Pause, Play, Send, Square, X } from 'lucide-react'

import type { OmniOverlayAPI } from '../../shared/contracts'
import type { OmniEvent, OmniSettings, OmniTask, OmniTaskSummary } from '../../shared/omni-contracts'
import './omni-overlay.css'

declare global {
  interface Window { omniOverlay: OmniOverlayAPI }
}

const TERMINAL = new Set(['completed', 'failed', 'stopped'])

function statusCopy(status: OmniTaskSummary['status']): string {
  return ({
    idle: 'Idle', listening: 'Listening', transcribing: 'Transcribing', planning: 'Planning',
    'waiting-for-approval': 'Waiting for approval', working: 'Working', 'using-cursor': 'Using cursor',
    speaking: 'Speaking', paused: 'Paused', completed: 'Complete', failed: 'Failed', stopped: 'Stopped'
  })[status]
}

function Overlay() {
  const [settings, setSettings] = useState<OmniSettings | null>(null)
  const [tasks, setTasks] = useState<OmniTaskSummary[]>([])
  const [activeTask, setActiveTask] = useState<OmniTask | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refreshTask = useCallback(async (taskId: string) => {
    const task = await window.omniOverlay.tasks.get(taskId)
    setActiveTask(task)
  }, [])

  const refresh = useCallback(async () => {
    const [nextSettings, nextTasks] = await Promise.all([
      window.omniOverlay.settings.get(),
      window.omniOverlay.tasks.list()
    ])
    setSettings(nextSettings)
    setTasks(nextTasks)
    const current = nextTasks.find((task) => !TERMINAL.has(task.status)) ?? nextTasks[0]
    if (current) await refreshTask(current.id)
    else setActiveTask(null)
  }, [refreshTask])

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    const offTask = window.omniOverlay.tasks.onTaskChanged((task) => {
      setTasks((current) => [task, ...current.filter((candidate) => candidate.id !== task.id)])
      setActiveTask((current) => {
        if (current && current.id !== task.id && !TERMINAL.has(current.status)) return current
        void refreshTask(task.id).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        return current
      })
    })
    const offEvent = window.omniOverlay.tasks.onEvent((event) => {
      setActiveTask((current) => current?.id === event.taskId
        ? { ...current, events: [...current.events.filter((item) => item.id !== event.id), event] }
        : current)
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void window.omniOverlay.activation.hide()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { offTask(); offEvent(); window.removeEventListener('keydown', onKeyDown) }
  }, [refresh, refreshTask])

  const running = activeTask && !TERMINAL.has(activeTask.status)
  const canStart = Boolean(settings?.enabled && settings.model.modelId.trim() && input.trim() && !running && !busy)
  const recentEvents = useMemo(() => activeTask?.events.slice(-4).reverse() ?? [], [activeTask])

  const start = async (): Promise<void> => {
    if (!canStart) return
    setBusy(true); setError('')
    try {
      const task = await window.omniOverlay.tasks.start(input.trim())
      setActiveTask(task)
      setInput('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  const control = async (action: 'pause' | 'resume' | 'stop'): Promise<void> => {
    if (!activeTask) return
    setBusy(true); setError('')
    try {
      const next = await window.omniOverlay.tasks[action](activeTask.id)
      await refreshTask(next.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  return <main className="omni-overlay-shell">
    <header className="omni-overlay-header">
      <div className="omni-overlay-brand"><span><AudioWaveform /></span><div><strong>Omni</strong><small>{settings?.model.modelId || 'Model not configured'}</small></div></div>
      <div className="omni-overlay-window-actions">
        <button type="button" onClick={() => void window.omniOverlay.activation.openMainWindow()} aria-label="Open Omni in OmniCode"><ExternalLink /></button>
        <button type="button" onClick={() => void window.omniOverlay.activation.hide()} aria-label="Close Omni overlay"><X /></button>
      </div>
    </header>

    {!settings?.enabled ? <section className="omni-overlay-blocked" role="status">
      <strong>Omni is not enabled</strong>
      <p>Open OmniCode to choose a model and enable system-assistant tasks.</p>
      <button type="button" onClick={() => void window.omniOverlay.activation.openMainWindow()}>Open Omni settings</button>
    </section> : <>
      <section className="omni-overlay-status" aria-live="polite">
        <span className={`omni-overlay-orb ${running ? 'active' : ''}`}><AudioWaveform /></span>
        <div><small>{activeTask ? statusCopy(activeTask.status) : 'Ready'}</small><strong>{activeTask?.title ?? 'What can I help you do?'}</strong>
          <p>{activeTask?.resultSummary ?? activeTask?.error ?? activeTask?.plan?.reasoningSummary ?? 'Invisible Mode uses approved background tools. Cursor Mode uses the signed native helper and pauses when you take control.'}</p>
        </div>
      </section>

      {activeTask?.plan && <section className="omni-overlay-plan">
        <span>{activeTask.plan.completedSteps}/{activeTask.plan.steps.length}</span>
        <div><small>Current step</small><strong>{activeTask.plan.currentStep}</strong><p>Next: {activeTask.plan.nextStep}</p></div>
      </section>}

      {recentEvents.length > 0 && <section className="omni-overlay-events" aria-label="Recent verified activity">
        {recentEvents.map((event: OmniEvent) => <div key={event.id}><span data-status={event.status} /><p><strong>{event.title}</strong>{event.summary}</p></div>)}
      </section>}

      {error && <div className="omni-overlay-error" role="alert">{error}</div>}

      <form className="omni-overlay-compose" onSubmit={(event) => { event.preventDefault(); void start() }}>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} maxLength={16_384}
          placeholder={running ? 'Finish or stop the active task before starting another.' : 'Ask Omni to do something…'} disabled={Boolean(running) || busy}
          rows={2} aria-label="Omni request" autoFocus />
        <button type="submit" disabled={!canStart} aria-label="Start Omni task">{busy ? <LoaderCircle className="spin" /> : <Send />}</button>
      </form>

      <footer className="omni-overlay-footer">
        <span>{settings?.executionMode === 'cursor' ? 'Cursor selected' : 'Invisible Mode'} · {settings?.approvalMode === 'ask' ? 'Always ask' : settings?.approvalMode === 'auto' ? 'Ask when needed' : 'Full Access'}</span>
        <div>
          {activeTask?.status === 'paused'
            ? <button type="button" onClick={() => void control('resume')} disabled={busy}><Play />Resume</button>
            : <button type="button" onClick={() => void control('pause')} disabled={!running || busy}><Pause />Pause</button>}
          <button type="button" onClick={() => void control('stop')} disabled={!running || busy}><Square />Stop</button>
        </div>
      </footer>
    </>}
  </main>
}

createRoot(document.getElementById('omni-overlay-root')!).render(<StrictMode><Overlay /></StrictMode>)
