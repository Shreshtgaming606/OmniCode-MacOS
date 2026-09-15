import type { AIProviderId } from './contracts'
import type { ToolActionCategory, ToolRiskLevel, WorkApprovalMode } from './tool-contracts'

export type CodeAgentVisibility = 'standard' | 'glasses'
export type CodeAgentFocusBehavior = 'automatic' | 'when-needed' | 'never'
export type CodeAgentTaskStatus = 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'stopped'
export type CodeAgentEventStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'info'
export type CodeAgentEventKind =
  | 'task'
  | 'plan'
  | 'decision'
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

export type CodeAgentPlanStepStatus = 'pending' | 'active' | 'completed' | 'skipped'
export type CodeAgentPlanUpdateType = 'initial' | 'progress' | 'changed'

export interface CodeAgentPlanStep {
  id: string
  title: string
  status: CodeAgentPlanStepStatus
}

/**
 * A bounded, model-authored user-facing summary. This is deliberately not raw
 * provider reasoning or chain-of-thought.
 */
export interface CodeAgentPlan {
  revision: number
  updateType: CodeAgentPlanUpdateType
  taskUnderstanding: string
  reasoningSummary: string
  steps: CodeAgentPlanStep[]
  completedSteps: number
  currentStep: string
  nextStep: string
  decision?: string
  assumptions?: string[]
  changeReason?: string
  updatedBy: 'system' | 'agent' | 'user'
  updatedAt: number
}

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
  reason?: string
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
  plan?: CodeAgentPlan
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
  resultCharacters: 8 * 1024,
  planUnderstandingCharacters: 1_000,
  reasoningSummaryCharacters: 2_000,
  planSteps: 20,
  planStepCharacters: 300,
  planDecisionCharacters: 1_000,
  planAssumptions: 10,
  planInterventionCharacters: 2_000
} as const
