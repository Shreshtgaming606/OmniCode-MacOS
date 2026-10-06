import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock3,
  LoaderCircle,
  RotateCcw,
  XCircle
} from 'lucide-react'

import './LiveActivityCard.css'

export type LiveActivityState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting' | 'retrying'

export interface LiveActivityEntry {
  id: string
  title: string
  summary?: string
  status: LiveActivityState
  startedAt: number
  completedAt?: number
  detail?: string
}

interface LiveActivityCardProps {
  mode: 'Code' | 'Work'
  status: LiveActivityState
  startedAt: number
  completedAt?: number
  entries: LiveActivityEntry[]
  modelLabel?: string
  filesChanged?: number
  checksPassed?: number
  defaultExpanded?: boolean
}

function elapsedLabel(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function stateLabel(status: LiveActivityState): string {
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Task failed'
  if (status === 'cancelled') return 'Task cancelled'
  if (status === 'waiting') return 'Waiting'
  if (status === 'retrying') return 'Retrying'
  if (status === 'queued') return 'Queued'
  return 'OmniCode is working'
}

function StatusIcon({ status }: { status: LiveActivityState }) {
  if (status === 'completed') return <CheckCircle2 />
  if (status === 'failed') return <CircleAlert />
  if (status === 'cancelled') return <XCircle />
  if (status === 'retrying') return <RotateCcw className="spin" />
  if (status === 'running' || status === 'waiting') return <LoaderCircle className="spin" />
  return <Circle />
}

export function LiveActivityCard({
  mode,
  status,
  startedAt,
  completedAt,
  entries,
  modelLabel,
  filesChanged = 0,
  checksPassed = 0,
  defaultExpanded = false
}: LiveActivityCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [now, setNow] = useState(() => Date.now())
  const active = ['queued', 'running', 'waiting', 'retrying'].includes(status)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  const completed = useMemo(() => entries.filter((entry) => entry.status === 'completed').length, [entries])
  const current = [...entries].reverse().find((entry) => ['running', 'waiting', 'retrying'].includes(entry.status)) ?? entries.at(-1)
  const elapsed = elapsedLabel(startedAt, completedAt ?? now)

  return <section className={`live-activity-card state-${status}`} aria-label={`${mode} Mode activity`}>
    <button className="live-activity-summary" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span className="live-activity-icon"><StatusIcon status={status} /></span>
      <span className="live-activity-copy">
        <span><strong>{stateLabel(status)}</strong><em>{mode} Mode{modelLabel ? ` · ${modelLabel}` : ''}</em></span>
        <small>{current?.title ?? (active ? 'Preparing the first action…' : stateLabel(status))}</small>
      </span>
      <span className="live-activity-meta"><span><Clock3 />{elapsed}</span><small>{completed} completed</small></span>
      {expanded ? <ChevronDown className="live-activity-chevron" /> : <ChevronRight className="live-activity-chevron" />}
    </button>
    {expanded && <div className="live-activity-detail">
      <ol>
        {entries.map((entry) => <li className={`state-${entry.status}`} key={entry.id}>
          <StatusIcon status={entry.status} />
          <span><strong>{entry.title}</strong>{entry.summary && entry.summary !== entry.title ? <small>{entry.summary}</small> : null}{entry.detail && <code>{entry.detail}</code>}</span>
          <time>{new Date(entry.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        </li>)}
        {!entries.length && <li className="state-queued"><Circle /><span><strong>Preparing the first action…</strong></span></li>}
      </ol>
      {!active && <footer>
        <span>{entries.length} action{entries.length === 1 ? '' : 's'}</span>
        {filesChanged > 0 && <span>{filesChanged} file{filesChanged === 1 ? '' : 's'} changed</span>}
        {checksPassed > 0 && <span>{checksPassed} check{checksPassed === 1 ? '' : 's'} passed</span>}
      </footer>}
      <p>Operational activity only. Private model reasoning is never displayed.</p>
    </div>}
  </section>
}
