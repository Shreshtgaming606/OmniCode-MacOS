import { useEffect, useState } from 'react'
import {
  Bot,
  CheckCircle2,
  FileDiff,
  ListChecks,
  LoaderCircle,
  Play,
  ShieldCheck,
  TerminalSquare
} from 'lucide-react'

import type { AIProviderId, DiffProposalChangeInput } from '../../../shared/contracts'

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

function permissionName(permission: AgentModeProps['permission']): string {
  if (permission === 'agent') return 'Agent Mode'
  if (permission === 'workspace') return 'Workspace Access'
  return 'Ask Every Time'
}

export function AgentMode({
  workspacePath,
  provider,
  model,
  activeFile,
  openFiles,
  terminalOutput,
  problems,
  gitChanges,
  permission,
  resetToken,
  prepareWorkspace,
  onReviewProposal,
  onRunCommand
}: AgentModeProps) {
  const [task, setTask] = useState('')
  const [plan, setPlan] = useState<AgentPlan | null>(null)
  const [proposalId, setProposalId] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'planning' | 'staging'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    setTask('')
    setPlan(null)
    setProposalId(null)
    setError('')
    setPhase('idle')
  }, [resetToken])

  const run = async (): Promise<void> => {
    if (!workspacePath || !task.trim() || !model.trim() || phase !== 'idle') return
    setError('')
    setPlan(null)
    setProposalId(null)
    const attachedPaths = [...new Set([...(activeFile ? [activeFile] : []), ...openFiles])].slice(0, 20)
    try {
      if (provider !== 'ollama') {
        const retrievedPaths = await window.omnicode.ai.contextPreview(workspacePath, task.trim())
        const contextDetails = [
          retrievedPaths.length ? `retrieved workspace files: ${retrievedPaths.join(', ')}` : 'retrieved workspace files: no indexed match',
          attachedPaths.length ? `open/active files: ${attachedPaths.join(', ')}` : '',
          terminalOutput ? `recent terminal output: ${Math.min(terminalOutput.length, 12_000).toLocaleString()} characters` : '',
          problems ? `editor problems: ${Math.min(problems.length, 8_000).toLocaleString()} characters` : '',
          gitChanges ? `Git changes: ${Math.min(gitChanges.length, 8_000).toLocaleString()} characters` : ''
        ].filter(Boolean)
        if (permission !== 'agent' && !window.confirm(
          `Send this context to ${provider} for the Agent task?\n\n• ${contextDetails.join('\n• ')}\n\nNothing is written until you accept the proposed diff. Commands always require a separate click and confirmation.`
        )) return
      }
      setPhase('saving')
      await prepareWorkspace()
      setPhase('planning')
      const diagnosticContext = [
        terminalOutput ? `Recent terminal output:\n${terminalOutput.slice(-12_000)}` : '',
        problems ? `Current editor problems:\n${problems.slice(0, 8_000)}` : '',
        gitChanges ? `Current Git changes:\n${gitChanges.slice(0, 8_000)}` : ''
      ].filter(Boolean).join('\n\n')
      const response = await window.omnicode.ai.chat({
        provider,
        model,
        workspacePath,
        attachWorkspaceContext: true,
        attachedPaths,
        messages: [
          {
            role: 'system',
            content: `You are OmniCode Agent, planning a safe change inside one open workspace. Return strict JSON only with this shape:\n{"summary":"short result","plan":["step"],"changes":[{"kind":"modify|create","path":"relative/path","content":"complete final file content"},{"kind":"delete","path":"relative/path"}],"commands":[{"command":"project command","reason":"why it is needed"}]}\nUse only relative workspace paths. Include complete final content for every created or modified file. Do not include unchanged files. Never propose sudo, destructive recursive deletion, system-setting changes, or access outside the workspace. Commands are suggestions only; do not claim to have run them. If context is insufficient, return no changes and explain the needed input in the plan.`
          },
          {
            role: 'user',
            content: `Task:\n${task.trim()}${diagnosticContext ? `\n\nRuntime context supplied by the user:\n${diagnosticContext}` : ''}`
          }
        ]
      })
      const nextPlan = parseAgentPlan(response.content)
      setPlan(nextPlan)
      if (nextPlan.changes.length) {
        setPhase('staging')
        const proposal = await window.omnicode.diff.propose({
          workspaceRoot: workspacePath,
          title: nextPlan.summary,
          changes: nextPlan.changes
        })
        setProposalId(proposal.id)
        onReviewProposal(proposal.id)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPhase('idle')
    }
  }

  const busy = phase !== 'idle'
  return <div className="agent-mode">
    <div className="agent-permission"><ShieldCheck /><span><strong>{permissionName(permission)}</strong><small>All edits are staged in a review and commands require a separate click plus native confirmation.</small></span></div>
    {!workspacePath ? <div className="agent-empty"><Bot /><strong>Open a workspace to use Agent Mode</strong><p>The agent is deliberately limited to the folder you choose.</p></div> : <>
      <div className="agent-task">
        <label htmlFor="agent-task-input">Describe a workspace task</label>
        <textarea id="agent-task-input" rows={5} value={task} disabled={busy} onChange={(event) => setTask(event.target.value)} placeholder="Add a login page using the existing design style…" />
        <small>Unsaved editor files are saved first. {provider === 'ollama' ? 'Planning runs locally on this Mac.' : 'Relevant context is sent only after confirmation.'}</small>
        <button className="agent-run" disabled={!task.trim() || !model.trim() || busy} onClick={() => void run()}>{busy ? <LoaderCircle className="spin" /> : <ListChecks />}{phase === 'saving' ? 'Saving files…' : phase === 'planning' ? 'Building plan…' : phase === 'staging' ? 'Preparing diff…' : 'Plan & Propose Changes'}</button>
      </div>
      {error && <div className="inline-error"><strong>Agent stopped safely</strong><p>{error}</p></div>}
      {plan && <div className="agent-result">
        <header><CheckCircle2 /><div><strong>{plan.summary}</strong><small>{plan.changes.length} proposed file change{plan.changes.length === 1 ? '' : 's'}</small></div></header>
        {plan.plan.length > 0 && <ol>{plan.plan.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>}
        {proposalId && <button className="agent-review" onClick={() => onReviewProposal(proposalId)}><FileDiff />Review Proposed Changes</button>}
        {!plan.changes.length && <p className="agent-no-changes">No files were staged. Refine the task or provide the input listed above.</p>}
        {plan.commands.length > 0 && <div className="agent-commands"><div><TerminalSquare /><strong>Suggested commands</strong></div>{plan.commands.map((item, index) => <article key={`${item.command}-${index}`}><code>{item.command}</code><small>{item.reason}</small><button onClick={() => onRunCommand(item.command, item.reason)}><Play />Review & Run</button></article>)}</div>}
      </div>}
    </>}
  </div>
}
