import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Bot,
  CircleStop,
  Clipboard,
  Eye,
  FileDiff,
  Glasses,
  History,
  ListChecks,
  LoaderCircle,
  Pause,
  Play,
  ShieldCheck,
  TerminalSquare,
  Trash2
} from 'lucide-react'

import type { AIProviderId, DiffProposalChangeInput } from '../../../shared/contracts'
import type { CodeAgentEvent, CodeAgentFocusBehavior, CodeAgentTask, CodeAgentTaskSummary, CodeAgentVisibility } from '../../../shared/code-agent-contracts'
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
    : events.filter((event) => event.kind === 'result' || event.status === 'failed' || event.status === 'waiting').slice(-8)
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

  const active = Boolean(currentTask && ['running', 'pausing', 'paused'].includes(currentTask.status))
  const events = currentTask?.events ?? []
  const latest = events.at(-1)
  const visibleEvents = useMemo(() => visibleAgentEvents(events, visibility), [events, visibility])

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
          <button className="danger" onClick={() => void window.omnicode.agent.stop(currentTask.id).then(setCurrentTask).catch((cause) => setError(String(cause)))}><CircleStop />Stop</button>
        </div>}
        {latest && <p className="agent-now"><Activity />{latest.title}: {latest.summary}</p>}
        {currentTask.resultSummary && <div className="agent-final-result"><strong>Result</strong><p>{currentTask.resultSummary}</p></div>}
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
      {event.relativePath && <small>Path: {event.relativePath}</small>}
      {event.url && <small>URL: {event.url}</small>}
      {event.output && <pre>{event.output}</pre>}
      <div>{event.proposalId && <button onClick={() => onReviewProposal(event.proposalId!)}><FileDiff />Review diff</button>}{event.output && <button onClick={() => void window.omnicode.app.copyText(event.output!)}><Clipboard />Copy output</button>}</div>
    </div>}
  </article>
}
