import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'

import type { GitFileChange, GitStatus } from '../../../shared/contracts'

interface ChangeGroupProps {
  title: string
  changes: GitFileChange[]
  actionTitle: string
  staged: boolean
  busy: boolean
  onAll(): void
  onAction(change: GitFileChange): void
  onOpenDiff(change: GitFileChange): void
}

function statusName(code: string): string {
  return ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'Untracked', T: 'Type changed' } as Record<string, string>)[code] ?? code
}

function ChangeGroup({ title, changes, actionTitle, staged, busy, onAll, onAction, onOpenDiff }: ChangeGroupProps) {
  if (!changes.length) return null
  return <section className="git-change-group">
    <div className="section-heading"><span>{title}</span><span>{changes.length}</span><button disabled={busy} title={`${actionTitle} all`} onClick={onAll}>{staged ? <Minus /> : <Plus />}</button></div>
    <div className="change-list">{changes.map((change) => {
      const code = staged ? change.indexStatus : change.workingTreeStatus === ' ' ? change.indexStatus : change.workingTreeStatus
      return <div className="change-row" key={`${staged ? 'staged' : 'working'}-${change.path}`}>
        <button className="change-file" onClick={() => onOpenDiff(change)} title={`${statusName(code)} · ${change.path}`}><span>{change.path.split('/').pop()}</span><small>{change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}</small></button>
        <span className={`git-status status-${code.replace('?', 'untracked').toLowerCase()}`} title={statusName(code)}>{code}</span>
        <button disabled={busy} title={actionTitle} onClick={() => onAction(change)}>{staged ? <Minus /> : <Plus />}</button>
      </div>
    })}</div>
  </section>
}

export function SourceControlView({ root, onOpenDiff, onStatus }: {
  root: string
  onOpenDiff(path: string, staged?: boolean): void
  onStatus(status: GitStatus): void
}) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setBusyAction('refresh')
    setError('')
    try {
      const next = await window.omnicode.git.status(root)
      setStatus(next)
      onStatus(next)
      setBranches(next.isRepository ? await window.omnicode.git.branches(root) : [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!quiet) setBusyAction(null)
    }
  }, [onStatus, root])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(true), 5_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const perform = async (name: string, operation: () => Promise<unknown>, success?: string): Promise<void> => {
    if (busyAction) return
    setBusyAction(name)
    setError('')
    setNotice('')
    try {
      await operation()
      if (success) setNotice(success)
      const next = await window.omnicode.git.status(root)
      setStatus(next)
      onStatus(next)
      setBranches(next.isRepository ? await window.omnicode.git.branches(root) : [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }

  const stagedChanges = useMemo(
    () => status?.changes.filter((change) => change.indexStatus !== ' ' && change.indexStatus !== '?') ?? [],
    [status]
  )
  const workingChanges = useMemo(
    () => status?.changes.filter((change) => change.workingTreeStatus !== ' ' || change.indexStatus === '?') ?? [],
    [status]
  )
  const busy = busyAction !== null

  if (status && !status.isRepository) return <div className="sidebar-view source-view">
    <div className="sidebar-title"><span>Source Control</span><button title="Refresh" onClick={() => void refresh()}><RefreshCw className={busyAction === 'refresh' ? 'spin' : ''} /></button></div>
    <div className="sidebar-empty"><GitBranch /><p>This folder is not a Git repository.</p><button className="primary-button" disabled={busy} onClick={() => void perform('init', () => window.omnicode.git.operation(root, 'init'), 'Repository initialized.')}>Initialize Repository</button>{status.error && <small>{status.error}</small>}{error && <small>{error}</small>}</div>
  </div>

  const createBranch = (): void => {
    const name = window.prompt('New branch name')?.trim()
    if (name) void perform('branch-create', () => window.omnicode.git.switchBranch(root, name, true), `Created and switched to ${name}.`)
  }

  const deleteBranch = (): void => {
    const candidates = branches.filter((branch) => branch !== status?.branch)
    if (!candidates.length) return
    const name = window.prompt(`Branch to delete:\n\n${candidates.join('\n')}`, candidates[0])?.trim()
    if (!name || !candidates.includes(name)) {
      if (name) setError('Choose an existing local branch other than the current branch.')
      return
    }
    void perform('branch-delete', async () => {
      try { await window.omnicode.git.deleteBranch(root, name) }
      catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        if (!window.confirm(`${detail}\n\nForce-delete ${name}? This can discard unmerged branch commits.`)) throw cause
        await window.omnicode.git.deleteBranch(root, name, true)
      }
    }, `Deleted ${name}.`)
  }

  return <div className="sidebar-view source-view">
    <div className="sidebar-title"><span>Source Control</span><div className="toolbar compact">
      <button disabled={busy} title="Fetch" onClick={() => void perform('fetch', () => window.omnicode.git.operation(root, 'fetch'), 'Fetched remote updates.')}><CloudDownload /></button>
      <button disabled={busy} title="Pull" onClick={() => void perform('pull', () => window.omnicode.git.operation(root, 'pull'), 'Pulled remote changes.')}><RefreshCw className={busyAction === 'pull' ? 'spin' : ''} /></button>
      <button disabled={busy} title="Push" onClick={() => void perform('push', () => window.omnicode.git.operation(root, 'push'), 'Pushed local commits.')}><CloudUpload /></button>
      <button disabled={busy} title="Refresh" onClick={() => void refresh()}><RefreshCw className={busyAction === 'refresh' ? 'spin' : ''} /></button>
    </div></div>
    {status && <div className="branch-controls"><GitBranch /><select aria-label="Current Git branch" disabled={busy} value={status.branch} onChange={(event) => void perform('branch-switch', () => window.omnicode.git.switchBranch(root, event.target.value), `Switched to ${event.target.value}.`)}>{!branches.includes(status.branch) && <option value={status.branch}>{status.branch}</option>}{branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select><span>{status.ahead ? `↑${status.ahead}` : ''}{status.behind ? `↓${status.behind}` : ''}</span><button disabled={busy} title="Create branch" onClick={createBranch}><Plus /></button><button disabled={busy || branches.filter((branch) => branch !== status.branch).length === 0} title="Delete another branch" onClick={deleteBranch}><Trash2 /></button></div>}
    <div className="commit-box"><textarea className="commit-input" rows={3} value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} placeholder="Commit message" /><button className="primary-button commit-button" disabled={!message.trim() || busy || !stagedChanges.length} title={stagedChanges.length ? 'Commit staged changes' : 'Stage changes before committing'} onClick={() => void perform('commit', async () => { await window.omnicode.git.commit(root, message); setMessage('') }, 'Commit created.')}><GitCommitHorizontal /> Commit <span>{stagedChanges.length || ''}</span></button></div>
    {error && <div className="inline-error">{error}</div>}
    {notice && <div className="git-notice"><Check />{notice}</div>}
    <ChangeGroup title="Staged Changes" changes={stagedChanges} staged busy={busy} actionTitle="Unstage" onAll={() => void perform('unstage-all', () => window.omnicode.git.unstage(root, ['.']))} onAction={(change) => void perform(`unstage-${change.path}`, () => window.omnicode.git.unstage(root, [change.path]))} onOpenDiff={(change) => onOpenDiff(change.path, true)} />
    <ChangeGroup title="Changes" changes={workingChanges} staged={false} busy={busy} actionTitle="Stage" onAll={() => void perform('stage-all', () => window.omnicode.git.stage(root, ['.']))} onAction={(change) => void perform(`stage-${change.path}`, () => window.omnicode.git.stage(root, [change.path]))} onOpenDiff={(change) => onOpenDiff(change.path, false)} />
    {status && !status.changes.length && <div className="source-clean"><Check /><strong>Working tree clean</strong><small>No staged or unstaged changes.</small></div>}
    {!status && <div className="empty-compact">{busy ? 'Reading Git status…' : 'Git status unavailable.'}</div>}
  </div>
}

