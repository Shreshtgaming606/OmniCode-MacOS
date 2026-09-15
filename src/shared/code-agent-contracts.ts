import type { AIProviderId } from './contracts'
import type { ToolActionCategory, ToolRiskLevel, WorkApprovalMode } from './tool-contracts'

export type CodeAgentVisibility = 'standard' | 'glasses'
export type CodeAgentFocusBehavior = 'automatic' | 'when-needed' | 'never'
export type CodeAgentTaskStatus = 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'stopped'
export type CodeAgentEventStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'info'
export type CodeAgentEventKind =
  | 'task'
  | 'terminal'
  | 'file'
  | 'git'
  | 'browser'
  | 'application'
  | 'server'
  | 'build'
  | 'test'
  | 'diagnostic'
  | 'approval'
  | 'result'

export interface CodeAgentStartRequest {
  provider: AIProviderId
  model: string
  workspaceRoot: string
  task: string
  approvalMode: WorkApprovalMode
  visibility: CodeAgentVisibility
  focusBehavior: CodeAgentFocusBehavior
}

export interface CodeAgentEvent {
  id: string
  taskId: string
  timestamp: number
  completedAt?: number
  kind: CodeAgentEventKind
  status: CodeAgentEventStatus
  title: string
  summary: string
  toolId?: string
  category?: ToolActionCategory
  risk?: ToolRiskLevel
  approvalMode?: WorkApprovalMode
  command?: string
  output?: string
  relativePath?: string
  url?: string
  proposalId?: string
}

export interface CodeAgentTaskSummary {
  id: string
  title: string
  provider: AIProviderId
  model: string
  approvalMode: WorkApprovalMode
  visibility: CodeAgentVisibility
  focusBehavior: CodeAgentFocusBehavior
  status: CodeAgentTaskStatus
  createdAt: number
  updatedAt: number
  completedAt?: number
  actionCount: number
  resultSummary?: string
  error?: string
}

export interface CodeAgentTask extends CodeAgentTaskSummary {
  events: CodeAgentEvent[]
}

export interface CodeAgentTaskChangedEvent {
  task: CodeAgentTaskSummary
}

export interface CodeAgentRuntimeEvent {
  taskId: string
  event: CodeAgentEvent
}

export const CODE_AGENT_LIMITS = {
  tasks: 100,
  eventsPerTask: 400,
  storeBytes: 16 * 1024 * 1024,
  taskCharacters: 16 * 1024,
  titleCharacters: 160,
  eventSummaryCharacters: 2_000,
  eventOutputCharacters: 32 * 1024,
  resultCharacters: 8 * 1024
} as const
