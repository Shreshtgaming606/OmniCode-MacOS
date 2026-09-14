import { AlertTriangle, Check, Shield, X } from 'lucide-react'

import type { WorkApprovalRequest } from '../../../../shared/tool-contracts'

export function WorkApprovalCard({ request, busy = false, onResolve }: {
  request: WorkApprovalRequest
  busy?: boolean
  onResolve(approved: boolean): void
}) {
  return <div className="work-safety-backdrop">
    <section className={`work-approval-card risk-${request.risk}`} role="alertdialog" aria-modal="true" aria-labelledby="work-approval-title">
      <header>
        <span className="work-approval-icon">{request.risk === 'high' || request.risk === 'critical' ? <AlertTriangle /> : <Shield />}</span>
        <span><small>{request.connectorName} · {request.risk} risk</small><h2 id="work-approval-title">{request.title}</h2></span>
      </header>
      <p className="work-approval-summary">{request.summary}</p>
      {!!request.details.length && <dl className="work-approval-details">{request.details.map((detail, index) => <div className={detail.multiline ? 'multiline' : ''} key={`${detail.label}-${index}`}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl>}
      <div className="work-approval-reason"><Shield /><span><strong>Why OmniCode is asking</strong><small>{request.reason}</small></span></div>
      <footer><button type="button" disabled={busy} autoFocus onClick={() => onResolve(false)}><X />Cancel</button><button type="button" className="primary-button" disabled={busy} onClick={() => onResolve(true)}><Check />{busy ? 'Approving…' : 'Approve once'}</button></footer>
    </section>
  </div>
}
