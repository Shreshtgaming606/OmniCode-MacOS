import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Database, Download, LoaderCircle, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react'
import type {
  AIUsageBudgetSettings,
  AIUsageBreakdown,
  AIUsageMode,
  AIUsageProvider,
  AIUsageQuery,
  AIUsageRetention,
  AIUsageSettings,
  AIUsageSummary,
  AIUsageTimePoint,
  ModelPricing
} from '../../../shared/ai-usage-contracts'

type Period = 'today' | '7d' | '30d' | 'month' | 'custom'
type ChartMetric = 'cost' | 'tokens' | 'requests'

const PROVIDER_LABELS: Record<AIUsageProvider, string> = {
  ollama: 'Ollama', openai: 'OpenAI', anthropic: 'Anthropic Claude', google: 'Google Gemini'
}
const MODE_LABELS: Record<AIUsageMode, string> = {
  code: 'Code', work: 'Work', omni: 'Omni', background: 'Background', unknown: 'Unknown'
}

function startOfToday(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function rangeFor(period: Period, customStart: string, customEnd: string): Pick<AIUsageQuery, 'startAt' | 'endAt' | 'granularity'> {
  const now = Date.now()
  if (period === 'today') return { startAt: startOfToday(), endAt: now + 1, granularity: 'hour' }
  if (period === '7d') return { startAt: now - 7 * 86_400_000, endAt: now + 1, granularity: 'day' }
  if (period === '30d') return { startAt: now - 30 * 86_400_000, endAt: now + 1, granularity: 'day' }
  if (period === 'month') {
    const start = new Date()
    start.setDate(1); start.setHours(0, 0, 0, 0)
    return { startAt: start.getTime(), endAt: now + 1, granularity: 'day' }
  }
  const startAt = customStart ? new Date(`${customStart}T00:00:00`).getTime() : now - 30 * 86_400_000
  const endDate = customEnd ? new Date(`${customEnd}T00:00:00`) : new Date()
  endDate.setDate(endDate.getDate() + 1)
  return { startAt, endAt: endDate.getTime(), granularity: 'day' }
}

function number(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function money(value: number | undefined): string {
  if (value === undefined) return 'Unavailable'
  if (value === 0) return '$0.00'
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: value < 0.01 ? 4 : 2, maximumFractionDigits: value < 0.01 ? 6 : 2 }).format(value)
}

function latency(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

function chartValue(point: AIUsageTimePoint, metric: ChartMetric): number {
  if (metric === 'cost') return point.estimatedCost ?? 0
  if (metric === 'tokens') return point.totalTokens ?? 0
  return point.requests
}

function UsageChart({ points, metric }: { points: AIUsageTimePoint[]; metric: ChartMetric }) {
  const width = 620
  const height = 150
  const values = points.map((point) => chartValue(point, metric))
  const maximum = Math.max(...values, 1)
  const plotted = values.map((value, index) => {
    const x = points.length <= 1 ? width / 2 : (index / (points.length - 1)) * width
    const y = height - (value / maximum) * (height - 22) - 10
    return `${x},${y}`
  }).join(' ')
  if (!points.length) return <div className="ai-usage-empty"><BarChart3 />No usage was recorded in this period.</div>
  return <div className="ai-usage-chart" aria-label={`${metric} usage over time`}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img">
      <defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".35"/><stop offset="1" stopColor="var(--accent)" stopOpacity="0"/></linearGradient></defs>
      {[.25, .5, .75, 1].map((line) => <line key={line} x1="0" x2={width} y1={height - line * (height - 20)} y2={height - line * (height - 20)} />)}
      {points.length > 1 && <polygon points={`0,${height} ${plotted} ${width},${height}`} fill="url(#usage-fill)" />}
      <polyline points={plotted} />
      {points.length === 1 && <circle cx={width / 2} cy={height - (values[0] / maximum) * (height - 22) - 10} r="4" />}
    </svg>
    <div className="ai-usage-chart-labels"><span>{points[0]?.label}</span><strong>{metric === 'cost' ? money(maximum) : number(maximum)} peak</strong><span>{points.at(-1)?.label}</span></div>
  </div>
}

function BudgetInput({ label, value, onChange }: { label: string; value?: number; onChange(value?: number): void }) {
  return <label><span>{label}</span><span className="ai-usage-money-input"><b>$</b><input type="number" min="0.01" step="0.01" placeholder="Not set" value={value ?? ''} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : undefined)} /></span></label>
}

export function AIUsageDashboard() {
  const [period, setPeriod] = useState<Period>('30d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [provider, setProvider] = useState<AIUsageProvider | ''>('')
  const [mode, setMode] = useState<AIUsageMode | ''>('')
  const [metric, setMetric] = useState<ChartMetric>('cost')
  const [summary, setSummary] = useState<AIUsageSummary | null>(null)
  const [pricing, setPricing] = useState<ModelPricing[]>([])
  const [settings, setSettings] = useState<AIUsageSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const query = useMemo<AIUsageQuery>(() => ({
    ...rangeFor(period, customStart, customEnd),
    provider: provider || undefined,
    mode: mode || undefined,
    limit: 100
  }), [period, customStart, customEnd, provider, mode])
  const breakdowns: Array<{ title: string; rows: AIUsageBreakdown[] }> = summary ? [
    { title: 'Providers', rows: summary.providers },
    { title: 'Models', rows: summary.models },
    { title: 'Modes', rows: summary.modes },
    { title: 'Features', rows: summary.features },
    { title: 'Projects', rows: summary.projects },
    { title: 'Conversations', rows: summary.conversations },
    { title: 'Agent runs', rows: summary.agentRuns }
  ] : []

  const refresh = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const [result, priceList] = await Promise.all([
        window.omnicode.ai.usage.summary(query),
        window.omnicode.ai.usage.pricing()
      ])
      setSummary(result)
      setPricing(priceList)
      setSettings(result.settings)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }, [query])

  useEffect(() => { void refresh() }, [refresh])

  const updateBudget = (key: keyof AIUsageBudgetSettings, value: number | boolean | undefined): void => {
    setSettings((current) => current ? ({ ...current, budgets: { ...current.budgets, [key]: value } }) : current)
  }
  const saveSettings = async (): Promise<void> => {
    if (!settings) return
    setBusy(true); setError(''); setMessage('')
    try {
      setSettings(await window.omnicode.ai.usage.updateSettings(settings))
      setMessage('Usage, retention, and budget settings saved locally.')
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const exportHistory = async (format: 'csv' | 'json'): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await window.omnicode.ai.usage.export(format, query)
      if (!result.cancelled) setMessage(`Exported ${result.recordCount ?? 0} usage records${result.path ? ` to ${result.path}` : ''}.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const deleteHistory = async (): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await window.omnicode.ai.usage.deleteHistory()
      if (!result.cancelled) {
        setMessage(`Deleted ${result.deletedRecords} local usage records.`)
        await refresh()
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="ai-usage-dashboard">
    <div className="ai-usage-toolbar">
      <div className="ai-usage-periods">
        {([['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['custom', 'Custom']] as const).map(([value, label]) => (
          <button key={value} className={period === value ? 'active' : ''} onClick={() => setPeriod(value)}>{label}</button>
        ))}
      </div>
      <button className="ai-usage-refresh" disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? 'spin' : ''} />Refresh</button>
    </div>
    {period === 'custom' && <div className="ai-usage-custom-range"><label>From<input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label>Through<input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}
    <div className="ai-usage-filters"><label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as AIUsageProvider | '')}><option value="">All providers</option>{Object.entries(PROVIDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Mode<select value={mode} onChange={(event) => setMode(event.target.value as AIUsageMode | '')}><option value="">All modes</option>{Object.entries(MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {error && <p className="ai-usage-alert error"><TriangleAlert />{error}</p>}
    {message && <p className="ai-usage-alert success"><ShieldCheck />{message}</p>}
    {!summary && busy ? <div className="ai-usage-loading"><LoaderCircle className="spin"/>Loading local usage history…</div> : summary && <>
      <div className="ai-usage-metrics">
        <article><small>Estimated API cost</small><strong>{money(summary.totals.estimatedCost)}</strong><span>{summary.totals.unpricedRequests ? `${summary.totals.unpricedRequests} unpriced request${summary.totals.unpricedRequests === 1 ? '' : 's'}` : 'All cloud requests priced'}</span></article>
        <article><small>Total tokens</small><strong>{number(summary.totals.totalTokens)}</strong><span>{number(summary.totals.inputTokens)} input · {number(summary.totals.outputTokens)} output</span></article>
        <article><small>Requests</small><strong>{number(summary.totals.requests)}</strong><span>{summary.totals.failedRequests} failed</span></article>
        <article><small>Average latency</small><strong>{latency(summary.totals.averageLatencyMs)}</strong><span>Provider round trip</span></article>
      </div>
      <div className="ai-usage-local-cloud"><span style={{ width: `${summary.localPercentage}%` }} /><div><b>Local {summary.localPercentage.toFixed(0)}%</b><small>{number(summary.local.totalTokens)} tokens · $0 API cost</small></div><div><b>Cloud {summary.cloudPercentage.toFixed(0)}%</b><small>{number(summary.cloud.totalTokens)} tokens · {money(summary.cloud.estimatedCost)}</small></div></div>
      <div className="ai-usage-card">
        <header><div><h3>Usage over time</h3><small>Actual provider-reported token metadata when available.</small></div><div className="ai-usage-segments">{(['cost', 'tokens', 'requests'] as const).map((value) => <button key={value} className={metric === value ? 'active' : ''} onClick={() => setMetric(value)}>{value}</button>)}</div></header>
        <UsageChart points={summary.timeSeries} metric={metric}/>
      </div>
      <div className="ai-usage-breakdowns">
        {breakdowns.map(({ title, rows }) => <div className="ai-usage-card" key={title}><h3>{title}</h3><div className="ai-usage-breakdown-list">{rows.length ? rows.slice(0, 10).map((row) => <div key={row.key}><span><b>{row.label}</b><small>{number(row.totalTokens)} tokens · {row.requests} requests</small></span><span><b>{row.local ? '$0 local' : money(row.estimatedCost)}</b><small>{row.percentage.toFixed(1)}%</small></span></div>) : <p>No records</p>}</div></div>)}
      </div>
      <div className="ai-usage-card">
        <header><div><h3>Budget controls</h3><small>Warnings are estimates. Provider billing remains authoritative.</small></div></header>
        <div className="ai-usage-budget-status">{summary.budget.windows.map((window) => <div key={window.window} data-reached={window.reached}><span><b>{window.window}</b><small>{window.limitUsd ? `${money(window.usedUsd)} of ${money(window.limitUsd)}` : 'No limit'}</small></span>{window.limitUsd && <progress max="100" value={Math.min(window.percentage ?? 0, 100)} />}{window.hasUnpricedUsage && <small>Includes unpriced usage</small>}</div>)}</div>
        {settings && <div className="ai-usage-settings-grid">
          <BudgetInput label="Daily budget" value={settings.budgets.dailyUsd} onChange={(value) => updateBudget('dailyUsd', value)} />
          <BudgetInput label="Weekly budget" value={settings.budgets.weeklyUsd} onChange={(value) => updateBudget('weeklyUsd', value)} />
          <BudgetInput label="Monthly budget" value={settings.budgets.monthlyUsd} onChange={(value) => updateBudget('monthlyUsd', value)} />
          <BudgetInput label="Large request warning" value={settings.budgets.largeRequestWarningUsd} onChange={(value) => updateBudget('largeRequestWarningUsd', value ?? 0)} />
          <label><span>Retention</span><select value={settings.retentionDays} onChange={(event) => setSettings({ ...settings, retentionDays: event.target.value === 'forever' ? 'forever' : Number(event.target.value) as AIUsageRetention })}><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="forever">Forever</option></select></label>
          <label className="ai-usage-checkbox"><input type="checkbox" checked={settings.budgets.hardStop} onChange={(event) => updateBudget('hardStop', event.target.checked)} /><span><b>Enforce hard budgets</b><small>Block new cloud requests once a configured limit is reached. Local Ollama remains available.</small></span></label>
          <button className="primary" disabled={busy} onClick={() => void saveSettings()}>Save usage settings</button>
        </div>}
      </div>
      <div className="ai-usage-card">
        <header><div><h3>Recent requests</h3><small>No prompts, responses, secrets, or authorization data are stored.</small></div></header>
        <div className="ai-usage-table-wrap"><table><thead><tr><th>Time</th><th>Mode / feature</th><th>Provider / model</th><th>Tokens</th><th>Cost</th><th>Latency</th><th>Status</th></tr></thead><tbody>{summary.recent.map((record) => <tr key={record.id}><td>{new Date(record.timestamp).toLocaleString()}</td><td>{MODE_LABELS[record.mode]}<small>{record.feature}</small></td><td>{PROVIDER_LABELS[record.provider]}<small>{record.model}</small></td><td>{number(record.totalTokens)}<small>{number(record.inputTokens)} in · {number(record.outputTokens)} out</small></td><td>{record.localModel ? '$0 local' : money(record.estimatedTotalCost)}<small>{record.pricingStatus.toLowerCase()}</small></td><td>{latency(record.latencyMs)}</td><td className={record.success ? 'success' : 'failed'}>{record.success ? 'Success' : record.errorType ?? 'Failed'}{record.rateLimit && <small>{record.rateLimit.status === 'limited' ? 'Rate limited' : record.rateLimit.requestsRemaining !== undefined ? `${record.rateLimit.requestsRemaining} requests left` : 'Rate limit healthy'}</small>}</td></tr>)}</tbody></table>{!summary.recent.length && <div className="ai-usage-empty"><Database/>No request metadata for these filters.</div>}</div>
      </div>
      <details className="ai-usage-card ai-usage-pricing"><summary>Pricing catalog and official sources</summary><p>USD per one million tokens. Exact provider billing is authoritative; unmatched models remain unavailable.</p><div>{pricing.map((price) => <div key={`${price.provider}-${price.model}`}><span><b>{price.displayName}</b><small>{PROVIDER_LABELS[price.provider]} · {price.model}</small></span><span><b>{price.status === 'FREE_LOCAL' ? '$0 local' : `${money(price.inputPricePerMillionTokens)} in · ${money(price.outputPricePerMillionTokens)} out`}</b><button type="button" onClick={() => void window.omnicode.app.openExternal(price.sourceUrl)}>Official source</button></span></div>)}</div></details>
      <div className="ai-usage-card ai-usage-data-controls"><div><h3>Your usage data</h3><p>Stored only on this Mac in OmniCode’s private application data. Exports contain metadata and stable opaque context IDs, never message content.</p><small>Pricing catalog {summary.pricingCatalogVersion}, updated {summary.pricingLastUpdated}. {summary.disclaimer}</small></div><div><button disabled={busy} onClick={() => void exportHistory('csv')}><Download/>Export CSV</button><button disabled={busy} onClick={() => void exportHistory('json')}><Download/>Export JSON</button><button className="danger" disabled={busy} onClick={() => void deleteHistory()}><Trash2/>Delete history</button></div></div>
    </>}
  </div>
}
