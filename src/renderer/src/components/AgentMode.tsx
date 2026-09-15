import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleStop,
  Clipboard,
  Eye,
  FileDiff,
  Glasses,
  History,
  ListChecks,
  LoaderCircle,
  Pause,
  PenLine,
  Play,
  ShieldCheck,
  SkipForward,
  TerminalSquare,
  Trash2
} from 'lucide-react'

import type { AIProviderId, DiffProposalChangeInput } from '../../../shared/contracts'
import type { CodeAgentEvent, CodeAgentFocusBehavior, CodeAgentPlan, CodeAgentTask, CodeAgentTaskSummary, CodeAgentVisibility } from '../../../shared/code-agent-contracts'
import type { WorkApprovalMode } from '../../../shared/tool-contracts'

interface AgentCommand {
  command: string
  reason: string
}

interface AgentPlan {
  summary: string
  plan: string[]
  changes: DiffProposalChangeInput[]
  commands: AgentCommand[]
}

interface AgentModeProps {
  workspacePath: string | null
  provider: AIProviderId
  model: string
  activeFile?: string
  openFiles: string[]
  terminalOutput: string
  problems: string
  gitChanges: string
  permission: 'ask' | 'workspace' | 'agent'
  resetToken: number
  prepareWorkspace(): Promise<void>
  onReviewProposal(proposalId: string): void
  onRunCommand(command: string, reason: string): void
}

function cleanJSON(value: string): string {
  const unfenced = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('The model did not return a valid agent plan. Try again or choose another model.')
  return unfenced.slice(start, end + 1)
}

export function relativeAgentPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('An agent change is missing its file path.')
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`The agent proposed an unsafe path: ${value}`)
  }
  return normalized
}

export function parseAgentPlan(value: string): AgentPlan {
  const parsed = JSON.parse(cleanJSON(value)) as Record<string, unknown>
  const rawPlan = Array.isArray(parsed.plan) ? parsed.plan : []
  const rawChanges = Array.isArray(parsed.changes) ? parsed.changes : []
  const rawCommands = Array.isArray(parsed.commands) ? parsed.commands : []
  if (rawChanges.length > 50) throw new Error('The agent proposed more than 50 files. Ask it to split the task into smaller steps.')

  const changes = rawChanges.map((entry): DiffProposalChangeInput => {
    if (!entry || typeof entry !== 'object') throw new Error('The agent returned an invalid file change.')
    const record = entry as Record<string, unknown>
    const path = relativeAgentPath(record.path)
    if (record.kind === 'delete') return { kind: 'delete', path }
    if ((record.kind === 'modify' || record.kind === 'create') && typeof record.content === 'string') {
      return { kind: record.kind, path, content: record.content }
    }
    throw new Error(`The proposed change for ${path} is incomplete.`)
  })

  return {
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : 'Agent plan ready for review.',
    plan: rawPlan.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()).slice(0, 20),
    changes,
    commands: rawCommands.flatMap((entry): AgentCommand[] => {
      if (!entry || typeof entry !== 'object') return []
      const record = entry as Record<string, unknown>
      if (typeof record.command !== 'string' || !record.command.trim()) return []
      return [{
        command: record.command.trim().slice(0, 2_000),
        reason: typeof record.reason === 'string' ? record.reason.trim() : 'Run a project command suggested by the agent.'
      }]
    }).slice(0, 10)
  }
}

export function visibleAgentEvents(events: CodeAgentEvent[], visibility: CodeAgentVisibility): CodeAgentEvent[] {
  return visibility === 'glasses'
    ? events
    : events.filter((event) => ['plan', 'decision', 'result', 'test', 'build'].includes(event.kind) || event.status === 'failed' || event.status === 'waiting').slice(-12)
}

export interface AgentFinalReport {
  whatIDid: string
  changes: string[]
  tests: string[]
  results: string[]
  problems: string[]
  planChanges: string[]
  remaining: string[]
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export function buildAgentFinalReport(task: CodeAgentTask): AgentFinalReport {
  const terminalChecks = /(?:^|\s)(?:npm|pnpm|yarn|bun|cargo|go|swift|xcodebuild)?\s*(?:test|build|check|lint|typecheck)|pytest|vitest|jest|cargo\s+(?:test|check|build)/iu
  const changes = task.events.filter((event) => event.status === 'succeeded' && (
    event.toolId?.startsWith('files.write') || event.toolId?.startsWith('files.delete') || Boolean(event.proposalId)
  )).map((event) => event.relativePath ? `${event.title}: ${event.relativePath}` : event.summary)
  const tests = task.events.filter((event) => ['test', 'build'].includes(event.kind) || Boolean(event.command && terminalChecks.test(event.command)))
    .map((event) => event.command ? `$ ${event.command}` : event.title)
  const results = task.events.filter((event) => ['test', 'build', 'result'].includes(event.kind) && ['succeeded', 'failed', 'cancelled'].includes(event.status))
    .map((event) => `${event.status === 'succeeded' ? 'Passed' : event.status === 'failed' ? 'Failed' : 'Cancelled'}: ${event.summary}`)
  const problems = task.events.filter((event) => event.status === 'failed').map((event) => event.summary)
  const planChanges = task.events.filter((event) => event.kind === 'plan' && /updated|change|skipped/iu.test(event.title)).map((event) => `${event.title}: ${event.summary}`)
  return {
    whatIDid: task.resultSummary ?? task.error ?? (task.status === 'stopped' ? 'The task was stopped by the user.' : 'The task ended without a summary.'),
    changes: unique(changes), tests: unique(tests), results: unique(results), problems: unique(problems), planChanges: unique(planChanges),
    remaining: task.error ? [task.error] : task.status === 'stopped' ? ['The stopped task may have unfinished work.'] : ['None reported by the Agent.']
  }
}

export function AgentMode({
  workspacePath,
  provider,
  model,
  permission,
  resetToken,
  prepareWorkspace,
  onReviewProposal,
}: AgentModeProps) {
  const [taskInput, setTaskInput] = useState('')
  const [currentTask, setCurrentTask] = useState<CodeAgentTask | null>(null)
  const [history, setHistory] = useState<CodeAgentTaskSummary[]>([])
  const [visibility, setVisibility] = useState<CodeAgentVisibility>('standard')
  const [focusBehavior, setFocusBehavior] = useState<CodeAgentFocusBehavior>('automatic')
  const [approvalMode, setApprovalMode] = useState<WorkApprovalMode>(permission === 'agent' ? 'full' : permission === 'workspace' ? 'auto' : 'ask')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [planExpanded, setPlanExpanded] = useState(false)
  const [editingPlan, setEditingPlan] = useState(false)
  const [planInstruction, setPlanInstruction] = useState('')

  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const [tasks, preferences] = await Promise.all([window.omnicode.agent.list(), window.omnicode.agent.getPreferences()])
        if (!active) return
        setHistory(tasks)
        setVisibility(preferences.visibility)
        setFocusBehavior(preferences.focusBehavior)
        const selected = tasks.find((task) => ['running', 'pausing', 'paused'].includes(task.status)) ?? tasks[0]
        if (selected) setCurrentTask(await window.omnicode.agent.get(selected.id))
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void refresh()
    const removeTask = window.omnicode.agent.onTaskChanged((summary) => {
      setHistory((items) => [summary, ...items.filter((item) => item.id !== summary.id)])
      setCurrentTask((task) => task?.id === summary.id ? { ...task, ...summary } : task)
    })
    const removeEvent = window.omnicode.agent.onEvent((event) => {
      setCurrentTask((task) => task?.id === event.taskId
        ? { ...task, events: [...task.events.filter((item) => item.id !== event.id), event].sort((left, right) => left.timestamp - right.timestamp), actionCount: task.events.some((item) => item.id === event.id) ? task.actionCount : task.actionCount + 1 }
        : task)
    })
    return () => { active = false; removeTask(); removeEvent() }
  }, [resetToken])

  useEffect(() => {
    setError('')
  }, [provider, model])

  useEffect(() => {
    if (visibility === 'glasses') setPlanExpanded(true)
  }, [visibility])

  const active = Boolean(currentTask && ['running', 'pausing', 'paused'].includes(currentTask.status))
  const events = currentTask?.events ?? []
  const latest = events.at(-1)
  const visibleEvents = useMemo(() => visibleAgentEvents(events, visibility), [events, visibility])

  const changePlan = async (): Promise<void> => {
    if (!currentTask || !planInstruction.trim()) return
    setError('')
    try {
      setCurrentTask(await window.omnicode.agent.modifyPlan(currentTask.id, planInstruction.trim()))
      setPlanInstruction('')
      setEditingPlan(false)
      setPlanExpanded(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const skipStep = async (): Promise<void> => {
    if (!currentTask) return
    setError('')
    try {
      setCurrentTask(await window.omnicode.agent.skipStep(currentTask.id))
      setPlanExpanded(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const run = async (): Promise<void> => {
    if (!workspacePath || !taskInput.trim() || !model.trim() || active || starting) return
    setError('')
    try {
      if (provider !== 'ollama' && !window.confirm(`Run this Code Agent task with ${provider}?\n\nThe agent can inspect relevant workspace files and send the file contents it reads to the selected cloud provider. Changes and commands remain governed by ${approvalMode === 'ask' ? 'Ask' : approvalMode === 'auto' ? 'Approve for me' : 'Full Access'} mode.`)) return
      setStarting(true)
      await prepareWorkspace()
      await window.omnicode.agent.setPreferences(visibility, focusBehavior)
      const started = await window.omnicode.agent.start({
        provider, model, workspaceRoot: workspacePath, task: taskInput.trim(), approvalMode, visibility, focusBehavior
      })
      setCurrentTask(started)
      setHistory((items) => [started, ...items.filter((item) => item.id !== started.id)])
      setTaskInput('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(false)
    }
  }

  return <div className="agent-mode">
    <div className="agent-control-grid">
      <label><span><ShieldCheck />Approval</span><select value={approvalMode} disabled={active} onChange={(event) => setApprovalMode(event.target.value as WorkApprovalMode)}><option value="ask">Ask</option><option value="auto">Approve for me</option><option value="full">Full Access</option></select></label>
      <label><span>{visibility === 'glasses' ? <Glasses /> : <Eye />}Visibility</span><select value={visibility} onChange={(event) => { const value = event.target.value as CodeAgentVisibility; setVisibility(value); void window.omnicode.agent.setPreferences(value, focusBehavior) }}><option value="standard">Standard</option><option value="glasses">Glasses</option></select></label>
      <label><span><Activity />Focus</span><select value={focusBehavior} onChange={(event) => { const value = event.target.value as CodeAgentFocusBehavior; setFocusBehavior(value); void window.omnicode.agent.setPreferences(visibility, value) }}><option value="automatic">Automatic</option><option value="when-needed">When needed</option><option value="never">Never</option></select></label>
    </div>
    <div className="agent-permission"><ShieldCheck /><span><strong>{approvalMode === 'ask' ? 'Ask before every change' : approvalMode === 'auto' ? 'Routine reversible work can continue' : 'Full Access with hard safety boundaries'}</strong><small>Reads are bounded. File edits use OmniCode’s diff/undo engine. Critical, credential, destructive, and external actions cannot bypass native policy.</small></span></div>
    {!workspacePath ? <div className="agent-empty"><Bot /><strong>Open a workspace to use Agent Mode</strong><p>The agent is deliberately limited to the folder you choose.</p></div> : <>
      <div className="agent-task">
        <label htmlFor="agent-task-input">Describe an implementation task</label>
        <textarea id="agent-task-input" rows={5} value={taskInput} disabled={active || starting} onChange={(event) => setTaskInput(event.target.value)} placeholder="Inspect the project, fix the failing tests, run them, and verify the result…" />
        <small>Unsaved editor files are saved first. The agent must observe real tool results before claiming success.</small>
        <button className="agent-run" disabled={!taskInput.trim() || !model.trim() || active || starting} onClick={() => void run()}>{starting ? <LoaderCircle className="spin" /> : <ListChecks />}{starting ? 'Starting task…' : active ? 'Task running' : 'Run Code Agent'}</button>
      </div>
      {error && <div className="inline-error"><strong>Code Agent error</strong><p>{error}</p></div>}
      {currentTask && <section className={`agent-live-task visibility-${visibility}`}>
        <header><span className={`agent-status ${currentTask.status}`}>{['running', 'pausing'].includes(currentTask.status) && <LoaderCircle className="spin" />}{currentTask.status === 'paused' && <Pause />}{currentTask.status}</span><strong>{currentTask.title}</strong></header>
        {active && <div className="agent-task-controls">
          {currentTask.status === 'paused' ? <button onClick={() => void window.omnicode.agent.resume(currentTask.id).then(setCurrentTask).catch((cause) => setError(String(cause)))}><Play />Resume</button> : <button onClick={() => void window.omnicode.agent.pause(currentTask.id).then(setCurrentTask).catch((cause) => setError(String(cause)))} disabled={currentTask.status === 'pausing'}><Pause />Pause</button>}
          {currentTask.status === 'running' && <button title="Pause the agent so you can use its visible browser or application, then choose Resume to return control." onClick={() => void window.omnicode.agent.pause(currentTask.id).then(setCurrentTask).catch((cause) => setError(String(cause)))}><TerminalSquare />Take over</button>}
          <button onClick={() => { setEditingPlan((value) => !value); setPlanExpanded(true) }}><PenLine />Modify Plan</button>
          <button onClick={() => void skipStep()}><SkipForward />Skip Step</button>
          <button className="danger" onClick={() => void window.omnicode.agent.stop(currentTask.id).then(setCurrentTask).catch((cause) => setError(String(cause)))}><CircleStop />Stop</button>
        </div>}
        {editingPlan && active && <div className="agent-plan-editor">
          <label htmlFor="agent-plan-instruction">Change the course of action</label>
          <textarea id="agent-plan-instruction" rows={3} maxLength={2_000} value={planInstruction} onChange={(event) => setPlanInstruction(event.target.value)} placeholder="For example: Do not install dependencies. Use the existing implementation." />
          <small>The Agent pauses at the next safe action boundary. Resume it after submitting this change.</small>
          <div><button onClick={() => { setEditingPlan(false); setPlanInstruction('') }}>Cancel</button><button className="primary" disabled={!planInstruction.trim()} onClick={() => void changePlan()}>Update Plan</button></div>
        </div>}
        {currentTask.plan && <AgentPlanPanel plan={currentTask.plan} expanded={planExpanded} onToggle={() => setPlanExpanded((value) => !value)} />}
        {latest && <p className="agent-now"><Activity />{latest.title}: {latest.summary}</p>}
        {['completed', 'failed', 'stopped'].includes(currentTask.status) && <AgentFinalReportView report={buildAgentFinalReport(currentTask)} status={currentTask.status} />}
        {currentTask.error && <div className="inline-error"><strong>Task failed</strong><p>{currentTask.error}</p></div>}
        <div className="agent-timeline">
          {visibleEvents.map((event) => <AgentTimelineEvent key={event.id} event={event} onReviewProposal={onReviewProposal} glasses={visibility === 'glasses'} />)}
          {!visibleEvents.length && <p className="agent-no-changes">Waiting for the first visible action…</p>}
        </div>
      </section>}
      <section className="agent-history">
        <header><span><History /><strong>Activity</strong></span>{history.length > 0 && <button title="Clear completed activity" onClick={() => void window.omnicode.agent.clearHistory().then(() => setHistory((items) => items.filter((item) => ['running', 'pausing', 'paused'].includes(item.status))))}><Trash2 /></button>}</header>
        {history.slice(0, 12).map((item) => <button key={item.id} className={currentTask?.id === item.id ? 'active' : ''} onClick={() => void window.omnicode.agent.get(item.id).then(setCurrentTask).catch((cause) => setError(String(cause)))}><span><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleString()}</small></span><em>{item.status} · {item.actionCount}</em></button>)}
        {!history.length && <p>No Code Agent tasks yet.</p>}
      </section>
    </>}
  </div>
}

function AgentTimelineEvent({ event, glasses, onReviewProposal }: { event: CodeAgentEvent; glasses: boolean; onReviewProposal(proposalId: string): void }) {
  const [expanded, setExpanded] = useState(event.status === 'failed' || event.status === 'waiting')
  return <article className={`agent-event ${event.status}`}>
    <button className="agent-event-summary" onClick={() => setExpanded((value) => !value)}><span><i /> <strong>{event.title}</strong></span><small>{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {event.status}</small></button>
    <p>{event.summary}</p>
    {(glasses || expanded) && <div className="agent-event-detail">
      {event.command && <code>$ {event.command}</code>}
      {event.reason && <small><strong>Reason:</strong> {event.reason}</small>}
      {event.relativePath && <small>Path: {event.relativePath}</small>}
      {event.url && <small>URL: {event.url}</small>}
      {event.output && <pre>{event.output}</pre>}
      <div>{event.proposalId && <button onClick={() => onReviewProposal(event.proposalId!)}><FileDiff />Review diff</button>}{event.output && <button onClick={() => void window.omnicode.app.copyText(event.output!)}><Clipboard />Copy output</button>}</div>
    </div>}
  </article>
}

function AgentPlanPanel({ plan, expanded, onToggle }: { plan: CodeAgentPlan; expanded: boolean; onToggle(): void }) {
  const completed = plan.steps.filter((step) => step.status === 'completed').length
  const percent = plan.steps.length ? Math.round((completed / plan.steps.length) * 100) : 0
  return <section className="agent-plan-panel">
    <button className="agent-plan-heading" onClick={onToggle} aria-expanded={expanded}>
      <span>{expanded ? <ChevronDown /> : <ChevronRight />}<strong>Agent Plan</strong><em>Revision {plan.revision + 1}</em></span>
      <small>{completed} / {plan.steps.length} complete</small>
    </button>
    <div className="agent-plan-progress" role="progressbar" aria-label="Agent plan progress" aria-valuemin={0} aria-valuemax={plan.steps.length} aria-valuenow={completed}><i style={{ width: `${percent}%` }} /></div>
    <div className="agent-plan-status">
      <span><Activity /><small>Current</small><strong>{plan.currentStep}</strong></span>
      <span><ArrowRight /><small>Next</small><strong>{plan.nextStep}</strong></span>
    </div>
    {expanded && <div className="agent-plan-detail">
      <div><small>Task</small><p>{plan.taskUnderstanding}</p></div>
      <div><small>Reasoning Summary</small><p>{plan.reasoningSummary}</p></div>
      {plan.decision && <div><small>Decision</small><p>{plan.decision}</p></div>}
      {plan.changeReason && <div className="changed"><small>Plan Updated</small><p>{plan.changeReason}</p></div>}
      {plan.assumptions?.length ? <div><small>Assumptions</small><ul>{plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div> : null}
      <ol>{plan.steps.map((step) => <li key={step.id} className={step.status}>{step.status === 'completed' ? <CheckCircle2 /> : step.status === 'active' ? <Activity /> : step.status === 'skipped' ? <SkipForward /> : <Circle />}<span>{step.title}</span><em>{step.status}</em></li>)}</ol>
      <p className="agent-reasoning-note">Reasoning Summary is a concise, user-facing explanation. Provider-private reasoning is never shown here.</p>
    </div>}
  </section>
}

function AgentFinalReportView({ report, status }: { report: AgentFinalReport; status: CodeAgentTask['status'] }) {
  const sections: Array<[string, string[], string]> = [
    ['What changed', report.changes, 'No file changes were recorded.'],
    ['Tests performed', report.tests, 'No tests were recorded.'],
    ['Results', report.results, 'No separate verification results were recorded.'],
    ['Problems encountered', report.problems, 'No problems were recorded.'],
    ['Plan changes', report.planChanges, 'No course changes were recorded.'],
    ['Remaining issues', report.remaining, 'None reported by the Agent.']
  ]
  return <section className={`agent-final-report ${status}`}>
    <header><CheckCircle2 /><span><strong>{status === 'completed' ? 'Completed' : status === 'failed' ? 'Task failed' : 'Task stopped'}</strong><small>Final task report</small></span></header>
    <div><small>What I did</small><p>{report.whatIDid}</p></div>
    {sections.map(([label, items, empty]) => <div key={label}><small>{label}</small>{items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{empty}</p>}</div>)}
  </section>
}
