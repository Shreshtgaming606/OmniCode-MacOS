import { AlertTriangle, ShieldCheck } from 'lucide-react'

export function FullAccessWarning({ busy = false, onEnable, onCancel }: {
  busy?: boolean
  onEnable(): void
  onCancel(): void
}) {
  return <div className="work-safety-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onCancel()
  }}>
    <section className="work-full-access-warning" role="alertdialog" aria-modal="true" aria-labelledby="work-full-access-title">
      <span className="work-warning-icon"><AlertTriangle /></span>
      <h2 id="work-full-access-title">Turn on Full access?</h2>
      <p>OmniCode will be able to perform normal Work Mode actions without asking each time, including sending messages and changing connected-app data.</p>
      <div><ShieldCheck /><span><strong>Hard safety boundaries stay active</strong><small>Critical actions, purchases or financial transfers, account-security changes, and irreversible destructive actions still require your direct approval.</small></span></div>
      <p className="work-warning-note">Instructions inside emails, files, websites, or model responses can never grant access or bypass these rules.</p>
      <footer><button type="button" disabled={busy} autoFocus onClick={onCancel}>Keep current setting</button><button type="button" className="danger-primary" disabled={busy} onClick={onEnable}>{busy ? 'Enabling…' : 'Enable Full access'}</button></footer>
    </section>
  </div>
}
