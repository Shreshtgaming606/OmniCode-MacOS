import type { AIProviderId } from '../../shared/contracts'
import type { JsonValue, ToolDescriptor } from '../../shared/tool-contracts'

export interface AIToolCall {
  callId: string
  name: string
  toolId?: string
  input: Record<string, JsonValue>
  /** Opaque provider fields that must be returned verbatim on the next tool round. */
  providerState?: {
    googleFunctionCallId?: string
    googleThoughtSignature?: string
  }
}

export type AIToolConversationMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant-tool'; content: string; calls: AIToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string }

export interface AIToolTurnRequest {
  provider: AIProviderId
  model: string
  system: string
  messages: AIToolConversationMessage[]
  tools: ToolDescriptor[]
}

export interface AIToolTurnResult {
  content: string
  calls: AIToolCall[]
  stopReason?: string
}
