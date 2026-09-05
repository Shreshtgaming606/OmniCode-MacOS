import { DiffEditor } from '@monaco-editor/react'
import {
  Check,
  CheckCheck,
  Columns2,
  FileDiff,
  FileMinus2,
  FilePlus2,
  List,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type {
  DiffDecisionTarget,
  DiffHunk,
  DiffProposal,
  DiffProposalFile
} from '../../../shared/contracts'
import { languageForPath } from '../lib/languages'
import './DiffReview.css'

export interface DiffReviewProps {
  proposalId: string | null
  visible?: boolean
  onClose?: () => void
  onProposalChange?: (proposal: DiffProposal) => void
}

type ReviewMode = 'unified' | 'side-by-side'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return typeof error === 'string' && error.trim() ? error : 'The change review operation failed.'
}

function statusLabel(status: DiffProposalFile['status']): string {
  if (status === 'accepted') return 'Accepted'
  if (status === 'rejected') return 'Rejected'
  if (status === 'partial') return 'Partially reviewed'
  return 'Pending review'
}

function FileKindIcon({ kind }: { kind: DiffProposalFile['kind'] }): ReactNode {
  if (kind === 'create') return <FilePlus2 aria-hidden="true" />
  if (kind === 'delete') return <FileMinus2 aria-hidden="true" />
  return <FileDiff aria-hidden="true" />
}

function HunkReview({
  hunk,
  busy,
  onAccept,
  onReject
}: {
  hunk: DiffHunk
  busy: boolean
  onAccept: () => void
  onReject: () => void
}): ReactNode {
  return (
    <section className={`diff-review__hunk diff-review__hunk--${hunk.status}`}>
      <header className="diff-review__hunk-header">
        <code>{hunk.header}</code>
        {hunk.status === 'pending' ? (
          <div className="diff-review__hunk-actions">
            <button disabled={busy} onClick={onReject} type="button">
              <X aria-hidden="true" />
              Reject hunk
            </button>
            <button className="is-accept" disabled={busy} onClick={onAccept} type="button">
              <Check aria-hidden="true" />
              Accept hunk
            </button>
          </div>
        ) : (
          <span className={`diff-review__decision diff-review__decision--${hunk.status}`}>
            {hunk.status === 'accepted' ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
            {hunk.status === 'accepted' ? 'Accepted' : 'Rejected'}
          </span>
        )}
      </header>

      {hunk.lines.length ? (
        <div className="diff-review__lines" role="table" aria-label={hunk.header}>
          {hunk.lines.map((line, index) => (
            <div
              className={`diff-review__line diff-review__line--${line.kind}`}
              key={`${hunk.id}-${index}`}
              role="row"
            >
              <span className="diff-review__line-number" role="cell">
                {line.oldLine ?? ''}
              </span>
              <span className="diff-review__line-number" role="cell">
                {line.newLine ?? ''}
              </span>
              <span className="diff-review__line-prefix" aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '}
              </span>
              <code role="cell">{line.content || ' '}</code>
            </div>
          ))}
        </div>
      ) : (
        <div className="diff-review__empty-hunk">Empty file</div>
      )}
    </section>
  )
}

export function DiffReview({
  proposalId,
  visible = true,
  onClose,
  onProposalChange
}: DiffReviewProps): ReactNode {
  const [proposal, setProposal] = useState<DiffProposal | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [mode, setMode] = useState<ReviewMode>('unified')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dark, setDark] = useState(() => {
    const preference = document.documentElement.dataset.theme
    return preference === 'dark' || (
      preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches
    )
  })

  const publish = useCallback((next: DiffProposal): void => {
    setProposal(next)
    onProposalChange?.(next)
  }, [onProposalChange])

  const loadProposal = useCallback(async (): Promise<void> => {
    if (!proposalId) {
      setProposal(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      publish(await window.omnicode.diff.get(proposalId))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [proposalId, publish])

  useEffect(() => {
    let cancelled = false
    if (!proposalId) {
      setProposal(null)
      setLoading(false)
      return undefined
    }

    setLoading(true)
    setError(null)
    void window.omnicode.diff.get(proposalId).then((next) => {
      if (!cancelled) publish(next)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(errorMessage(cause))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [proposalId, publish])

  useEffect(() => window.omnicode.diff.onChanged((next) => {
    if (next.id === proposalId) publish(next)
  }), [proposalId, publish])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => {
      const preference = document.documentElement.dataset.theme
      setDark(preference === 'dark' || (preference !== 'light' && media.matches))
    }
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [])

  useEffect(() => {
    if (!proposal?.files.length) {
      setSelectedFileId(null)
      return
    }
    if (!selectedFileId || !proposal.files.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(proposal.files[0]?.id ?? null)
    }
  }, [proposal, selectedFileId])

  const selectedFile = useMemo(
    () => proposal?.files.find((file) => file.id === selectedFileId) ?? null,
    [proposal, selectedFileId]
  )

  const decide = useCallback(async (
    decision: 'accept' | 'reject',
    target: DiffDecisionTarget,
    operationLabel: string
  ): Promise<void> => {
    if (!proposalId || busy) return
    setBusy(operationLabel)
    setError(null)
    try {
      const next = decision === 'accept'
        ? await window.omnicode.diff.accept(proposalId, target)
        : await window.omnicode.diff.reject(proposalId, target)
      publish(next)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }, [busy, proposalId, publish])

  const undo = useCallback(async (): Promise<void> => {
    if (!proposalId || busy) return
    setBusy('undo')
    setError(null)
    try {
      publish(await window.omnicode.diff.undo(proposalId))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }, [busy, proposalId, publish])

  const pendingInFile = selectedFile?.hunks.some((hunk) => hunk.status === 'pending') ?? false

  return (
    <section
      aria-label="AI change review"
      className="diff-review"
      hidden={!visible}
    >
      <header className="diff-review__header">
        <div className="diff-review__title">
          <span className="diff-review__title-icon"><ShieldCheck aria-hidden="true" /></span>
          <span>
            <strong>{proposal?.title ?? 'AI change review'}</strong>
            <small>
              {proposal
                ? `${proposal.files.length} file${proposal.files.length === 1 ? '' : 's'} · ${proposal.pendingHunks} pending`
                : 'Review proposed workspace edits before they touch disk'}
            </small>
          </span>
        </div>

        <div className="diff-review__global-actions" role="toolbar" aria-label="Proposal actions">
          <button
            disabled={!proposal?.canUndo || busy !== null}
            onClick={() => void undo()}
            title="Undo the most recent accepted change"
            type="button"
          >
            <RotateCcw aria-hidden="true" />
            Undo
          </button>
          <button
            disabled={!proposal?.pendingHunks || busy !== null}
            onClick={() => void decide('reject', { scope: 'all' }, 'reject-all')}
            type="button"
          >
            <X aria-hidden="true" />
            Reject all
          </button>
          <button
            className="is-primary"
            disabled={!proposal?.pendingHunks || busy !== null}
            onClick={() => void decide('accept', { scope: 'all' }, 'accept-all')}
            type="button"
          >
            {busy === 'accept-all' ? (
              <LoaderCircle className="diff-review__spin" aria-hidden="true" />
            ) : (
              <CheckCheck aria-hidden="true" />
            )}
            Accept all
          </button>
          {onClose ? (
            <button aria-label="Close change review" className="is-icon" onClick={onClose} title="Close" type="button">
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="diff-review__error" role="alert">
          <span>{error}</span>
          <button disabled={loading} onClick={() => void loadProposal()} type="button">Retry</button>
          <button aria-label="Dismiss error" onClick={() => setError(null)} type="button"><X /></button>
        </div>
      ) : null}

      {loading && !proposal ? (
        <div className="diff-review__state" role="status">
          <LoaderCircle className="diff-review__spin" aria-hidden="true" />
          Loading proposed changes…
        </div>
      ) : !proposal ? (
        <div className="diff-review__state">
          <FileDiff aria-hidden="true" />
          <strong>No change proposal selected</strong>
          <span>AI edits remain in memory until a proposal is opened and accepted.</span>
        </div>
      ) : (
        <div className="diff-review__body">
          <aside className="diff-review__files" aria-label="Changed files">
            <div className="diff-review__files-summary">
              <span>Files</span>
              <span className={`diff-review__proposal-status diff-review__proposal-status--${proposal.status}`}>
                {statusLabel(proposal.status)}
              </span>
            </div>
            <div className="diff-review__file-list" role="listbox" aria-label="Proposed files">
              {proposal.files.map((file) => (
                <button
                  aria-label={`${file.relativePath}, ${statusLabel(file.status)}`}
                  aria-selected={file.id === selectedFileId}
                  className={file.id === selectedFileId ? 'is-selected' : ''}
                  key={file.id}
                  onClick={() => setSelectedFileId(file.id)}
                  role="option"
                  type="button"
                >
                  <FileKindIcon kind={file.kind} />
                  <span className="diff-review__file-copy">
                    <strong>{file.relativePath.split('/').at(-1)}</strong>
                    <small>{file.relativePath}</small>
                  </span>
                  <span className="diff-review__counts" aria-label={`${file.additions} additions, ${file.deletions} deletions`}>
                    <b>+{file.additions}</b>
                    <i>−{file.deletions}</i>
                  </span>
                  <span className={`diff-review__file-status diff-review__file-status--${file.status}`} aria-hidden="true" />
                </button>
              ))}
            </div>
          </aside>

          <main className="diff-review__content">
            {selectedFile ? (
              <>
                <header className="diff-review__file-header">
                  <div>
                    <FileKindIcon kind={selectedFile.kind} />
                    <span>
                      <strong>{selectedFile.relativePath}</strong>
                      <small>{statusLabel(selectedFile.status)}</small>
                    </span>
                  </div>
                  <div className="diff-review__file-actions">
                    <div className="diff-review__mode" role="group" aria-label="Diff display mode">
                      <button
                        aria-pressed={mode === 'unified'}
                        className={mode === 'unified' ? 'is-active' : ''}
                        onClick={() => setMode('unified')}
                        title="Unified diff"
                        type="button"
                      >
                        <List aria-hidden="true" />
                      </button>
                      <button
                        aria-pressed={mode === 'side-by-side'}
                        className={mode === 'side-by-side' ? 'is-active' : ''}
                        onClick={() => setMode('side-by-side')}
                        title="Side-by-side diff"
                        type="button"
                      >
                        <Columns2 aria-hidden="true" />
                      </button>
                    </div>
                    <button
                      disabled={!pendingInFile || busy !== null}
                      onClick={() => void decide(
                        'reject',
                        { scope: 'file', fileId: selectedFile.id },
                        `reject-${selectedFile.id}`
                      )}
                      type="button"
                    >
                      <X aria-hidden="true" /> Reject file
                    </button>
                    <button
                      className="is-accept"
                      disabled={!pendingInFile || busy !== null}
                      onClick={() => void decide(
                        'accept',
                        { scope: 'file', fileId: selectedFile.id },
                        `accept-${selectedFile.id}`
                      )}
                      type="button"
                    >
                      <Check aria-hidden="true" /> Accept file
                    </button>
                  </div>
                </header>

                {mode === 'side-by-side' ? (
                  <div className="diff-review__monaco">
                    <DiffEditor
                      language={languageForPath(selectedFile.path)}
                      modified={selectedFile.reviewContent}
                      original={selectedFile.currentContent}
                      theme={dark ? 'vs-dark' : 'light'}
                      options={{
                        automaticLayout: true,
                        enableSplitViewResizing: true,
                        fontFamily: "'SFMono-Regular', Menlo, Monaco, monospace",
                        fontSize: 12,
                        lineHeight: 19,
                        minimap: { enabled: false },
                        readOnly: true,
                        renderSideBySide: true,
                        scrollBeyondLastLine: false,
                        wordWrap: 'off'
                      }}
                    />
                  </div>
                ) : (
                  <div className="diff-review__unified">
                    {selectedFile.hunks.map((hunk) => (
                      <HunkReview
                        busy={busy !== null}
                        hunk={hunk}
                        key={hunk.id}
                        onAccept={() => void decide(
                          'accept',
                          { scope: 'hunk', fileId: selectedFile.id, hunkId: hunk.id },
                          `accept-${selectedFile.id}-${hunk.id}`
                        )}
                        onReject={() => void decide(
                          'reject',
                          { scope: 'hunk', fileId: selectedFile.id, hunkId: hunk.id },
                          `reject-${selectedFile.id}-${hunk.id}`
                        )}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="diff-review__state">Select a file to review its changes.</div>
            )}
          </main>
        </div>
      )}
    </section>
  )
}

export default DiffReview
