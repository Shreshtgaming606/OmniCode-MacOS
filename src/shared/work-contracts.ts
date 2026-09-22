import type { AIProviderId } from './contracts'

export type AppMode = 'code' | 'work' | 'omni'

export type WorkMessageRole = 'user' | 'assistant'
export type WorkMessageStatus = 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled'
export type WorkAttachmentKind = 'file' | 'image' | 'connected-resource'
export type WorkAttachmentSource = 'computer' | 'connected-app'
export type WorkToolActivityStatus =
  | 'pending'
  | 'running'
  | 'awaiting-confirmation'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type WorkToolPreviewKind =
  | 'gmail-messages'
  | 'gmail-message'
  | 'gmail-draft'
  | 'drive-files'
  | 'drive-file'
  | 'transferred-file'

export interface WorkToolPreviewItem {
  title: string
  subtitle?: string
  detail?: string
  metadata?: string
}

/**
 * A deliberately small, display-only projection of a connector result. It
 * excludes provider IDs, URLs, paths, opaque transfer IDs, and raw bodies.
 */
export interface WorkToolPreview {
  kind: WorkToolPreviewKind
  label: string
  items: WorkToolPreviewItem[]
  count?: number
  truncated?: boolean
}

/**
 * Persisted attachment metadata. File bytes, OAuth tokens, temporary download
 * URLs, and connector response bodies intentionally do not belong here.
 */
export interface WorkAttachment {
  id: string
  name: string
  kind: WorkAttachmentKind
  source: WorkAttachmentSource
  createdAt: number
  mimeType?: string
  sizeBytes?: number
  connectorId?: string
  resourceId?: string
}

/**
 * A user-facing activity record, not a raw tool request or result. This keeps
 * credentials, tool arguments, and potentially sensitive response bodies out
 * of conversation metadata.
 */
export interface WorkToolActivity {
  id: string
  toolId: string
  name: string
  status: WorkToolActivityStatus
  createdAt: number
  connectorId?: string
  summary?: string
  preview?: WorkToolPreview
  completedAt?: number
  errorCode?: string
}

export interface WorkMessage {
  id: string
  role: WorkMessageRole
  content: string
  createdAt: number
  status?: WorkMessageStatus
  attachments?: WorkAttachment[]
  toolActivities?: WorkToolActivity[]
}

export interface WorkConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  provider: AIProviderId
  modelId: string
  messageCount: number
}

export interface WorkConversation extends WorkConversationSummary {
  messages: WorkMessage[]
}

export interface CreateWorkConversationRequest {
  title?: string
  provider?: AIProviderId
  modelId?: string
}

export interface UpdateWorkConversationRequest {
  title?: string
  pinned?: boolean
  provider?: AIProviderId
  modelId?: string
}

export interface CreateWorkMessageRequest {
  role: WorkMessageRole
  content: string
  status?: WorkMessageStatus
  attachments?: WorkAttachment[]
  toolActivities?: WorkToolActivity[]
}

export interface UpdateWorkMessageRequest {
  content?: string
  status?: WorkMessageStatus
  attachments?: WorkAttachment[]
  toolActivities?: WorkToolActivity[]
}

export interface WorkConversationSearchRequest {
  query?: string
  limit?: number
}

export interface WorkAgentChatRequest {
  provider: AIProviderId
  model: string
  messages: Array<Pick<WorkMessage, 'role' | 'content'> & { attachmentIds?: string[] }>
}

export interface WorkAgentChatResponse {
  content: string
  toolActivities: WorkToolActivity[]
  toolCallCount: number
  cancelled?: boolean
}

export interface WorkAgentStreamEvent {
  requestId: string
  type: 'delta'
  delta: string
}

export interface RecoverWorkConversationStoreResult {
  recovered: boolean
  backupPath?: string
}

export const WORK_CONVERSATION_LIMITS = {
  storeBytes: 32 * 1024 * 1024,
  conversations: 500,
  messagesPerConversation: 500,
  messageBytes: 128 * 1024,
  conversationBytes: 8 * 1024 * 1024,
  titleCharacters: 160,
  modelIdCharacters: 256,
  attachmentsPerMessage: 20,
  toolActivitiesPerMessage: 50,
  searchCharacters: 256,
  searchResults: 100
} as const
