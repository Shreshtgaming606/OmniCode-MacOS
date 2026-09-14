import type { AppMode } from './work-contracts'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ToolValueSchema =
  | {
      type: 'string'
      description?: string
      minLength?: number
      maxLength?: number
      enum?: string[]
      format?: 'https-url'
    }
  | {
      type: 'number' | 'integer'
      description?: string
      minimum?: number
      maximum?: number
    }
  | {
      type: 'boolean'
      description?: string
    }
  | {
      type: 'array'
      description?: string
      items: ToolValueSchema
      minItems?: number
      maxItems?: number
    }
  | {
      type: 'object'
      description?: string
      properties: Record<string, ToolValueSchema>
      required?: string[]
      additionalProperties?: false
    }

export type ToolActionClass = 'read' | 'write' | 'destructive' | 'sensitive'
export type ToolConfirmationPolicy = 'never' | 'policy' | 'always'
export type ConnectorAccessLevel = 'read-only' | 'ask-before-changes' | 'trusted'
export type WorkApprovalMode = 'ask' | 'auto' | 'full'
export type ToolActionCategory =
  | 'read'
  | 'write'
  | 'communication'
  | 'destructive'
  | 'external-submission'
  | 'system'
  | 'financial'
  | 'account-security'
  | 'sensitive-data'
export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface ToolDescriptor {
  id: string
  name: string
  description: string
  connectorId: string
  modes: readonly AppMode[]
  action: ToolActionClass
  category: ToolActionCategory
  risk: ToolRiskLevel
  reversible: boolean
  externalSideEffect: boolean
  confirmation: ToolConfirmationPolicy
  requiredScopes: readonly string[]
  inputSchema: Extract<ToolValueSchema, { type: 'object' }>
  resultSchema?: ToolValueSchema
  timeoutMs?: number
  maxResultBytes?: number
}

export interface ToolExecutionRequest {
  toolId: string
  mode: AppMode
  input: Record<string, JsonValue>
}

export interface ToolConfirmationRequest {
  toolId: string
  toolName: string
  connectorId: string
  action: ToolActionClass
  category: ToolActionCategory
  risk: ToolRiskLevel
  approvalMode: WorkApprovalMode
  summary: string
  reason: string
  input: Record<string, JsonValue>
}

export interface ToolAuthorizationDecision {
  approvalMode: WorkApprovalMode
  risk: ToolRiskLevel
  requiredApproval: boolean
  userApproved: boolean
  reason: string
}

export interface ToolExecutionResult {
  toolId: string
  startedAt: string
  completedAt: string
  result: JsonValue
  authorization: ToolAuthorizationDecision
}

export interface WorkPermissionSettings {
  version: 1
  globalMode: WorkApprovalMode
  connectorOverrides: Record<string, WorkApprovalMode>
  fullAccessWarningAcknowledged: boolean
}

export interface WorkApprovalDetail {
  label: string
  value: string
  multiline?: boolean
}

export interface WorkApprovalRequest {
  id: string
  toolId: string
  toolName: string
  connectorId: string
  connectorName: string
  category: ToolActionCategory
  risk: ToolRiskLevel
  approvalMode: WorkApprovalMode
  title: string
  summary: string
  reason: string
  details: WorkApprovalDetail[]
}

export type WorkActionHistoryResult = 'succeeded' | 'failed' | 'cancelled' | 'blocked'

export interface WorkActionHistoryEntry {
  id: string
  timestamp: number
  completedAt: number
  toolId: string
  toolName: string
  connectorId: string
  connectorName: string
  category: ToolActionCategory
  risk: ToolRiskLevel
  approvalMode: WorkApprovalMode
  approval: 'automatic' | 'user-approved' | 'user-cancelled' | 'blocked'
  result: WorkActionHistoryResult
  summary: string
}

export type ConnectorConnectionState =
  | 'not-connected'
  | 'connecting'
  | 'connected'
  | 'authentication-expired'
  | 'permission-missing'
  | 'network-error'
  | 'rate-limited'
  | 'service-unavailable'

export interface ConnectorStatus {
  connectorId: string
  state: ConnectorConnectionState
  message: string
  checkedAt?: string
  grantedScopes: readonly string[]
}

export interface ConnectorDescriptor {
  id: string
  name: string
  description: string
  capabilities: readonly string[]
  requestedScopes: readonly string[]
  accessLevel: ConnectorAccessLevel
  status: ConnectorStatus
}
