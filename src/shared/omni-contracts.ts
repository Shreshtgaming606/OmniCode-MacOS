import type { AIProviderId } from './contracts'
import type { ToolActionCategory, ToolRiskLevel, WorkApprovalMode } from './tool-contracts'

/** How Omni carries out a task. This is intentionally separate from approval policy. */
export type OmniExecutionMode = 'invisible' | 'cursor'

export type OmniStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'planning'
  | 'waiting-for-approval'
  | 'working'
  | 'using-cursor'
  | 'speaking'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'

export type OmniActivationSource = 'main-window' | 'overlay' | 'global-shortcut' | 'wake-word' | 'menu-bar'
export type OmniVoiceActivation = 'off' | 'shortcut-only' | 'wake-word-and-shortcut'

export type OmniPermissionId =
  | 'microphone'
  | 'speech-recognition'
  | 'accessibility'
  | 'screen-recording'
  | 'automation'
  | 'files-and-folders'

export type OmniPermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unavailable'

export interface OmniPermissionsSnapshot {
  checkedAt: number
  permissions: Record<OmniPermissionId, OmniPermissionState>
}

export interface OmniVoiceSettings {
  voiceId: string
  speakingRate: number
  spokenResponses: boolean
}

export interface OmniVoiceAvailability {
  available: boolean
  reason?: string
}

export interface OmniInstalledVoice {
  id: string
  name: string
  locale: string
}

export interface OmniSpeechInputAvailability {
  available: boolean
  providerId: string
  reason?: string
  microphonePermission: OmniPermissionState
  speechRecognitionPermission: OmniPermissionState
  onDevice: boolean
  streaming: boolean
  locale: string
  supportedLocales: string[]
}

export interface OmniSpeechInputEvent {
  sessionId: string
  type: 'listening' | 'partial' | 'final' | 'cancelled' | 'error'
  transcript?: string
  error?: string
}

export interface OmniSpeechRecognitionResult {
  transcript: string
  cancelled: boolean
}

export interface OmniSpeechStartOptions {
  locale?: string
  /** Omni's current privacy contract requires local recognition. */
  requireOnDevice?: true
}

export interface OmniSettings {
  version: 1
  enabled: boolean
  launchHelperAtLogin: boolean
  menuBarItem: boolean
  activation: {
    shortcut: string
    voiceActivation: OmniVoiceActivation
  }
  voice: OmniVoiceSettings
  model: {
    provider: AIProviderId
    modelId: string
  }
  executionMode: OmniExecutionMode
  approvalMode: WorkApprovalMode
  fullAccessWarningAcknowledged: boolean
  privacy: {
    wakeWordProcessing: 'on-device-only'
    screenObservationEnabled: boolean
    activityRetentionDays: number
  }
}

export type OmniPlanStepStatus = 'pending' | 'active' | 'completed' | 'skipped'
export type OmniPlanUpdateType = 'initial' | 'progress' | 'changed'

export interface OmniPlanStep {
  id: string
  title: string
  status: OmniPlanStepStatus
}

/**
 * A concise, user-facing course of action. `reasoningSummary` is a bounded
 * explanation and must never contain hidden chain-of-thought or raw prompts.
 */
export interface OmniPlan {
  revision: number
  updateType: OmniPlanUpdateType
  taskUnderstanding: string
  reasoningSummary: string
  steps: OmniPlanStep[]
  completedSteps: number
  currentStep: string
  nextStep: string
  decision?: string
  assumptions?: string[]
  changeReason?: string
  updatedBy: 'system' | 'agent' | 'user'
  updatedAt: number
}

export type OmniEventStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'info'
export type OmniEventKind =
  | 'activation'
  | 'voice'
  | 'task'
  | 'plan'
  | 'decision'
  | 'tool'
  | 'approval'
  | 'terminal'
  | 'file'
  | 'git'
  | 'browser'
  | 'application'
  | 'cursor'
  | 'result'
  | 'error'

/**
 * Persistable activity metadata. Deliberately excludes prompts, transcripts,
 * arbitrary tool inputs, absolute paths, screen captures, and authentication
 * material.
 */
export interface OmniEvent {
  id: string
  taskId: string
  timestamp: number
  completedAt?: number
  kind: OmniEventKind
  status: OmniEventStatus
  title: string
  summary: string
  toolId?: string
  connectorId?: string
  category?: ToolActionCategory
  risk?: ToolRiskLevel
  approvalMode?: WorkApprovalMode
  executionMode?: OmniExecutionMode
  reason?: string
  output?: string
}

export interface OmniTaskSummary {
  id: string
  title: string
  provider: AIProviderId
  model: string
  approvalMode: WorkApprovalMode
  executionMode: OmniExecutionMode
  activationSource: OmniActivationSource
  status: OmniStatus
  createdAt: number
  updatedAt: number
  completedAt?: number
  actionCount: number
  resultSummary?: string
  error?: string
  plan?: OmniPlan
}

export interface OmniTask extends OmniTaskSummary {
  events: OmniEvent[]
}

/** Runtime-only request. The raw user input must not be copied into OmniTask history. */
export interface OmniStartRequest {
  provider: AIProviderId
  model: string
  input: string
  activationSource: OmniActivationSource
  executionMode: OmniExecutionMode
  approvalMode: WorkApprovalMode
}

export type OmniControlAction = 'pause' | 'resume' | 'stop'

export interface OmniControlRequest {
  taskId: string
  action: OmniControlAction
}

export interface OmniExecutionModeChangeRequest {
  taskId: string
  executionMode: OmniExecutionMode
}

export interface OmniPlanModificationRequest {
  taskId: string
  instruction: string
}

export interface OmniTaskChangedEvent {
  task: OmniTaskSummary
}

export interface OmniRuntimeEvent {
  taskId: string
  event: OmniEvent
}

export const OMNI_DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space' as const

export const OMNI_LIMITS = {
  settingsStoreBytes: 64 * 1024,
  taskStoreBytes: 16 * 1024 * 1024,
  tasks: 100,
  eventsPerTask: 400,
  inputCharacters: 16 * 1024,
  shortcutCharacters: 128,
  voiceIdCharacters: 256,
  modelCharacters: 256,
  titleCharacters: 160,
  eventTitleCharacters: 200,
  eventSummaryCharacters: 2_000,
  eventOutputCharacters: 32 * 1024,
  resultCharacters: 8 * 1024,
  errorCharacters: 2_000,
  planUnderstandingCharacters: 1_000,
  reasoningSummaryCharacters: 2_000,
  planSteps: 20,
  planStepCharacters: 300,
  planDecisionCharacters: 1_000,
  planAssumptions: 10,
  activityRetentionDays: 90
} as const

export function createDefaultOmniSettings(): OmniSettings {
  return {
    version: 1,
    enabled: false,
    launchHelperAtLogin: false,
    menuBarItem: false,
    activation: {
      shortcut: OMNI_DEFAULT_SHORTCUT,
      voiceActivation: 'shortcut-only'
    },
    voice: {
      voiceId: '',
      speakingRate: 1,
      spokenResponses: true
    },
    model: {
      provider: 'ollama',
      modelId: ''
    },
    executionMode: 'invisible',
    approvalMode: 'ask',
    fullAccessWarningAcknowledged: false,
    privacy: {
      wakeWordProcessing: 'on-device-only',
      screenObservationEnabled: false,
      activityRetentionDays: 30
    }
  }
}
