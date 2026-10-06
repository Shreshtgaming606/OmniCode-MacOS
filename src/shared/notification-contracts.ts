import type { AppMode } from './work-contracts'

export type NotificationType =
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'TASK_CANCELLED'
  | 'BUILD_COMPLETED'
  | 'BUILD_FAILED'
  | 'TESTS_COMPLETED'
  | 'TESTS_FAILED'
  | 'EMAIL_SENT'
  | 'EMAIL_FAILED'
  | 'DRIVE_UPLOAD_COMPLETED'
  | 'DRIVE_UPLOAD_FAILED'
  | 'DOWNLOAD_COMPLETED'
  | 'DOWNLOAD_FAILED'
  | 'MODEL_LOADED'
  | 'MODEL_DOWNLOAD_COMPLETED'
  | 'BACKGROUND_TASK_COMPLETED'
  | 'BACKGROUND_TASK_FAILED'
  | 'CONNECTOR_ERROR'
  | 'SYSTEM_WARNING'

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'
export type NotificationSourceMode = AppMode | 'system'

export interface OmniNotification {
  id: string
  type: NotificationType
  title: string
  description: string
  timestamp: number
  read: boolean
  sourceMode: NotificationSourceMode
  severity: NotificationSeverity
  conversationId?: string
  taskId?: string
  actionTarget?: {
    mode: AppMode
    conversationId?: string
    taskId?: string
  }
}

export interface CreateOmniNotification {
  type: NotificationType
  title: string
  description: string
  sourceMode: NotificationSourceMode
  severity: NotificationSeverity
  conversationId?: string
  taskId?: string
  actionTarget?: OmniNotification['actionTarget']
}

export interface NotificationSettings {
  version: 1
  inApp: boolean
  nativeMacOS: boolean
  backgroundCompletions: boolean
  failures: boolean
  emailSent: boolean
  buildFinished: boolean
}

export interface NotificationSnapshot {
  notifications: OmniNotification[]
  unreadCount: number
  settings: NotificationSettings
}

export const NOTIFICATION_LIMITS = {
  notifications: 200,
  titleCharacters: 120,
  descriptionCharacters: 500,
  storeBytes: 512 * 1024
} as const
