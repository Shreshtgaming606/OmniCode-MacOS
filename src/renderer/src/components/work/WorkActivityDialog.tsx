import { CheckCircle2, CircleAlert, Clock3, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { WorkActionHistoryEntry } from '../../../../shared/tool-contracts'

function resultLabel(entry: WorkActionHistoryEntry): string {
  if (entry.result === 'succeeded') return entry.approval === 'automatic' ? 'Completed automatically' : 'Approved and completed'
  if (entry.result === 'cancelled') return 'Cancelled'
  if (entry.result === 'blocked') return 'Blocked'
  return 'Failed'
}

export function WorkActivityDialog({ onClose, onError }: { onClose(): void; onError(error: unknown): void }) {
  const [entries, setEntries] = useState<WorkActionHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const refresh = (): void => {
    setLoading(true)
    void window.omnicode.work.activity.list(300).then(setEntries).catch(onError).finally(() => setLoading(false))
  }
  useEffect(() => {
    refresh()
    const removeChanged = window.omnicode.work.activity.onChanged((entry) => setEntries((current) => [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 300)))
    const removeCleared = window.omnicode.work.activity.onCleared(() => setEntries([]))
    return () => { removeChanged(); removeCleared() }
  // The activity subscription is intentionally established once for this dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div className="work-safety-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="work-activity-dialog" role="dialog" aria-modal="true" aria-labelledby="work-activity-title">
      <header><span><Clock3 /><span><h2 id="work-activity-title">Work activity</h2><small>Safe action metadata stored privately on this Mac</small></span></span><button type="button" autoFocus title="Close Work activity" onClick={onClose}><X /></button></header>
      <div className="work-activity-list">
        {loading && <div className="work-activity-empty"><Clock3 /><p>Loading recent actions…</p></div>}
        {!loading && !entries.length && <div className="work-activity-empty"><ShieldCheck /><p>No Work actions have been recorded yet.</p><small>Inputs, email bodies, file contents, and credentials are never stored here.</small></div>}
        {entries.map((entry) => <article className={`result-${entry.result}`} key={entry.id}>
          <span>{entry.result === 'succeeded' ? <CheckCircle2 /> : <CircleAlert />}</span>
          <div><header><strong>{entry.toolName}</strong><time>{new Date(entry.timestamp).toLocaleString()}</time></header><p>{entry.summary}</p><footer><small>{entry.connectorName}</small><small>{entry.approvalMode === 'auto' ? 'Approve for me' : entry.approvalMode === 'full' ? 'Full access' : 'Ask'}</small><small>{entry.risk} risk</small><small>{resultLabel(entry)}</small></footer></div>
        </article>)}
      </div>
      <footer><span>Kept locally · up to 500 recent actions</span><button type="button" disabled={!entries.length} onClick={() => {
        if (!window.confirm('Clear Work activity history from this Mac?')) return
        void window.omnicode.work.activity.clear().catch(onError)
      }}><Trash2 />Clear history</button></footer>
    </section>
  </div>
}
