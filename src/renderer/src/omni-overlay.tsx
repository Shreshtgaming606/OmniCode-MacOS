import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Check, ExternalLink, Mic, RotateCcw, Square, X } from 'lucide-react'

import type { OmniOverlayAPI } from '../../shared/contracts'
import type {
  OmniEvent,
  OmniPermissionId,
  OmniSettings,
  OmniSpeechOutputEvent,
  OmniTask,
  OmniTaskSummary
} from '../../shared/omni-contracts'
import './omni-overlay.css'

declare global {
  interface Window { omniOverlay: OmniOverlayAPI }
}

const TERMINAL = new Set(['completed', 'failed', 'stopped'])
type OverlayPhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'working' | 'speaking' | 'completed' | 'failed' | 'permission'

function taskPhase(status: OmniTaskSummary['status']): OverlayPhase {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'stopped') return 'failed'
  if (status === 'planning') return 'thinking'
  if (status === 'speaking') return 'speaking'
  if (status === 'listening') return 'listening'
  if (status === 'transcribing') return 'transcribing'
  return 'working'
}

function phaseLabel(phase: OverlayPhase): string {
  return ({
    idle: 'Ready', listening: 'Listening…', transcribing: 'Understanding…', thinking: 'Understanding…',
    working: 'Working…', speaking: 'Speaking…', completed: 'Done', failed: 'Omni needs attention',
    permission: 'Permission needed'
  })[phase]
}

function eventSummary(event: OmniEvent): string {
  if (event.status === 'failed') return event.summary || 'That action did not finish.'
  return ({
    browser: 'Working in the browser…', application: 'Opening an application…', terminal: 'Running a command…',
    file: 'Working with files…', git: 'Updating the repository…', cursor: 'Controlling the Mac…',
    approval: 'Waiting for your approval…', plan: 'Preparing the next step…', result: event.summary || 'Finishing up…'
  } as Partial<Record<OmniEvent['kind'], string>>)[event.kind] ?? 'Working on your request…'
}

function shortText(value: string, maximum = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`
}

export function Overlay() {
  const [settings, setSettings] = useState<OmniSettings | null>(null)
  const [activeTask, setActiveTask] = useState<OmniTask | null>(null)
  const [phase, setPhase] = useState<OverlayPhase>('idle')
  const [transcript, setTranscript] = useState('')
  const [summary, setSummary] = useState('Say what you need. Omni will handle the rest.')
  const [amplitude, setAmplitude] = useState(0.08)
  const [error, setError] = useState('')
  const [permissionNeeded, setPermissionNeeded] = useState<OmniPermissionId | null>(null)
  const [permissionBusy, setPermissionBusy] = useState(false)
  const sessionRef = useRef<string | null>(null)
  const taskRef = useRef<OmniTask | null>(null)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearDismiss = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current)
    dismissTimer.current = null
  }, [])

  const hideLater = useCallback((delay = 4_000) => {
    clearDismiss()
    dismissTimer.current = setTimeout(() => { void window.omniOverlay.activation.hide() }, delay)
  }, [clearDismiss])

  const refreshTask = useCallback(async (taskId: string) => {
    const task = await window.omniOverlay.tasks.get(taskId)
    taskRef.current = task
    setActiveTask(task)
    setPhase(taskPhase(task.status))
    if (task.resultSummary) setSummary(shortText(task.resultSummary))
    else if (task.error) setError(shortText(task.error))
    return task
  }, [])

  const startTask = useCallback(async (input: string) => {
    const request = input.trim()
    if (!request) {
      setPhase('idle')
      setSummary('I didn’t catch that. Press the shortcut to try again.')
      hideLater()
      return
    }
    setPhase('transcribing')
    setSummary('Understanding your request…')
    setError('')
    try {
      const task = await window.omniOverlay.tasks.start(request)
      taskRef.current = task
      setActiveTask(task)
      setPhase('thinking')
      setSummary('Preparing a safe course of action…')
    } catch (cause) {
      setPhase('failed')
      setError(shortText(cause instanceof Error ? cause.message : String(cause)))
    }
  }, [hideLater])

  const beginListening = useCallback(async () => {
    clearDismiss()
    setError('')
    setTranscript('')
    setPermissionNeeded(null)
    setAmplitude(0.08)
    try {
      const permissions = await window.omniOverlay.permissions.status()
      if (permissions.permissions.microphone !== 'granted') {
        setPermissionNeeded('microphone'); setPhase('permission'); setSummary('Omni needs microphone access to hear your request.'); return
      }
      if (permissions.permissions['speech-recognition'] !== 'granted') {
        setPermissionNeeded('speech-recognition'); setPhase('permission'); setSummary('Omni needs Speech Recognition access to understand your request.'); return
      }
      const availability = await window.omniOverlay.voice.inputAvailability()
      if (!availability.available) {
        setPhase('failed')
        setError(shortText(availability.reason ?? 'Voice input is unavailable on this Mac.'))
        return
      }
      const started = await window.omniOverlay.voice.startInput({ locale: availability.locale, requireOnDevice: true })
      sessionRef.current = started.sessionId
      setPhase('listening')
      setSummary('I’m listening.')
    } catch (cause) {
      setPhase('failed')
      setError(shortText(cause instanceof Error ? cause.message : String(cause)))
    }
  }, [clearDismiss])

  const activate = useCallback(async () => {
    clearDismiss()
    setError('')
    const nextSettings = await window.omniOverlay.settings.get()
    setSettings(nextSettings)
    if (!nextSettings.enabled) {
      setPhase('failed'); setError('Finish Omni setup in OmniCode before using the global shortcut.'); return
    }
    const tasks = await window.omniOverlay.tasks.list()
    const current = tasks.find((task) => !TERMINAL.has(task.status))
    if (current) {
      await refreshTask(current.id)
      return
    }
    await beginListening()
  }, [beginListening, clearDismiss, refreshTask])

  const close = useCallback(async () => {
    clearDismiss()
    const sessionId = sessionRef.current
    sessionRef.current = null
    if (sessionId) await window.omniOverlay.voice.cancelInput(sessionId).catch(() => false)
    await window.omniOverlay.activation.hide()
  }, [clearDismiss])

  const enablePermission = useCallback(async () => {
    if (!permissionNeeded || permissionBusy) return
    setPermissionBusy(true)
    setError('')
    try {
      const result = await window.omniOverlay.permissions.request(permissionNeeded)
      if (result.state === 'granted') await beginListening()
      else {
        setPhase('permission')
        setSummary(result.state === 'requires-settings' || result.state === 'denied'
          ? `Enable ${result.label} in System Settings, then return to OmniCode.`
          : `${result.label} is not available yet.`)
      }
    } catch (cause) {
      setError(shortText(cause instanceof Error ? cause.message : String(cause)))
    } finally { setPermissionBusy(false) }
  }, [beginListening, permissionBusy, permissionNeeded])

  useEffect(() => {
    const offShow = window.omniOverlay.activation.onShow(() => { void activate() })
    const offTask = window.omniOverlay.tasks.onTaskChanged((task) => {
      const current = taskRef.current
      if (current && current.id !== task.id && !TERMINAL.has(current.status)) return
      void refreshTask(task.id).then((full) => {
        if (full.status === 'completed') hideLater()
      }).catch((cause) => { setPhase('failed'); setError(shortText(cause instanceof Error ? cause.message : String(cause))) })
    })
    const offEvent = window.omniOverlay.tasks.onEvent((event) => {
      if (taskRef.current?.id !== event.taskId) return
      setSummary(shortText(eventSummary(event)))
      if (event.status === 'failed') setPhase('failed')
    })
    const offInput = window.omniOverlay.voice.onInputEvent((event) => {
      if (sessionRef.current !== event.sessionId) return
      if (event.type === 'amplitude') { setAmplitude(event.amplitude ?? 0); return }
      if (event.type === 'partial') { setTranscript(shortText(event.transcript ?? '', 240)); return }
      if (event.type === 'listening') { setPhase('listening'); return }
      sessionRef.current = null
      if (event.type === 'final') { setTranscript(shortText(event.transcript ?? '', 240)); void startTask(event.transcript ?? ''); return }
      if (event.type === 'cancelled') { setPhase('idle'); return }
      setPhase('failed'); setError(shortText(event.error ?? 'Voice input stopped unexpectedly.'))
    })
    const offOutput = window.omniOverlay.voice.onOutputEvent((event: OmniSpeechOutputEvent) => {
      if (event.taskId && taskRef.current?.id !== event.taskId) return
      if (event.type === 'speaking') {
        clearDismiss(); setPhase('speaking'); setSummary(shortText(event.text ?? ''))
      } else if (event.type === 'finished' || event.type === 'interrupted') {
        const task = taskRef.current
        if (task?.status === 'completed') { setPhase('completed'); hideLater() }
        else if (task) setPhase(taskPhase(task.status))
      }
    })
    const offPermission = window.omniOverlay.permissions.onChanged((snapshot) => {
      if (permissionNeeded && snapshot.permissions[permissionNeeded] === 'granted') void beginListening()
    })
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') void close() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      offShow(); offTask(); offEvent(); offInput(); offOutput(); offPermission()
      window.removeEventListener('keydown', onKeyDown)
      clearDismiss()
    }
  }, [activate, beginListening, clearDismiss, close, hideLater, permissionNeeded, refreshTask, startTask])

  const bars = useMemo(() => Array.from({ length: 13 }, (_, index) => {
    const center = 1 - Math.abs(index - 6) / 7
    return Math.max(0.12, Math.min(1, amplitude * (0.78 + center * 1.5) + center * 0.16))
  }), [amplitude])

  const running = Boolean(activeTask && !TERMINAL.has(activeTask.status))
  const visibleText = error || transcript || summary

  return <main className={`omni-voice-overlay phase-${phase}`} aria-live="polite">
    <header className="omni-voice-header">
      <div className="omni-voice-brand"><span className="omni-mark" aria-hidden="true" /><strong>Omni</strong></div>
      <div className="omni-window-actions">
        <button type="button" onClick={() => void window.omniOverlay.activation.openMainWindow()} aria-label="Open full Omni"><ExternalLink /></button>
        <button type="button" onClick={() => void close()} aria-label="Close Omni"><X /></button>
      </div>
    </header>

    <section className="omni-voice-center">
      <div className="omni-wave" aria-hidden="true">
        <span className="wave-bracket left" />
        <div className="wave-bars">{bars.map((value, index) => <i key={index} style={{ '--level': value } as React.CSSProperties} />)}</div>
        <span className="wave-bracket right" />
      </div>
      <strong className="omni-phase-label">{phase === 'completed' && <Check />}{phaseLabel(phase)}</strong>
      <p className={error ? 'error' : ''}>{visibleText}</p>
    </section>

    <footer className="omni-voice-actions">
      {permissionNeeded && <>
        <button className="primary" type="button" disabled={permissionBusy} onClick={() => void enablePermission()}><Mic />{permissionBusy ? 'Requesting…' : 'Enable'}</button>
        <button type="button" onClick={() => void window.omniOverlay.permissions.openSettings(permissionNeeded)}>Open Settings</button>
      </>}
      {phase === 'failed' && !permissionNeeded && <button className="primary" type="button" onClick={() => void beginListening()}><RotateCcw />Try Again</button>}
      {running && <button type="button" className="stop" onClick={() => activeTask && void window.omniOverlay.tasks.stop(activeTask.id)}><Square />Stop Task</button>}
    </footer>
  </main>
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('omni-overlay-root')
  if (root) createRoot(root).render(<StrictMode><Overlay /></StrictMode>)
}
