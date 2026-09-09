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

export interface ToolDescriptor {
  id: string
  name: string
  description: string
  connectorId: string
  modes: readonly AppMode[]
  action: ToolActionClass
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
  summary: string
  input: Record<string, JsonValue>
}

export interface ToolExecutionResult {
  toolId: string
  startedAt: string
  completedAt: string
  result: JsonValue
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
