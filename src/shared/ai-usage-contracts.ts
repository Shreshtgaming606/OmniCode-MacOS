export type AIUsageProvider = 'ollama' | 'openai' | 'anthropic' | 'google'

export type AIUsageMode = 'code' | 'work' | 'omni' | 'background' | 'unknown'

export type AIUsageFeature =
  | 'chat'
  | 'agent'
  | 'workspace-analysis'
  | 'code-completion'
  | 'inline-edit'
  | 'tool-planning'
  | 'tool-result-processing'
  | 'voice'
  | 'background-task'
  | 'context-summarization'
  | 'browser-agent'
  | 'other'

export type AIUsageType = 'TEXT_AI' | 'STT' | 'TTS' | 'IMAGE' | 'OTHER'

export type PricingStatus = 'CURRENT' | 'STALE' | 'UNKNOWN' | 'CUSTOM' | 'FREE_LOCAL'

export interface AIUsageContext {
  mode: AIUsageMode
  feature: AIUsageFeature
  conversationId?: string
  projectId?: string
  agentRunId?: string
  taskId?: string
  usageType?: AIUsageType
}

export interface AIRateLimitSnapshot {
  status: 'healthy' | 'limited' | 'unknown'
  requestsRemaining?: number
  tokensRemaining?: number
  resetAt?: string
  retryAfterSeconds?: number
}

export interface AIProviderUsageMetadata {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface AIUsageRecord extends AIProviderUsageMetadata {
  id: string
  schemaVersion: 1
  timestamp: number
  provider: AIUsageProvider
  model: string
  mode: AIUsageMode
  feature: AIUsageFeature
  usageType: AIUsageType
  conversationId?: string
  projectId?: string
  agentRunId?: string
  taskId?: string
  requestCount: 1
  estimatedInputCost?: number
  estimatedOutputCost?: number
  estimatedCachedCost?: number
  estimatedCacheWriteCost?: number
  estimatedTotalCost?: number
  currency: 'USD'
  latencyMs: number
  success: boolean
  errorType?: string
  localModel: boolean
  pricingSource: string
  pricingVersion: string
  pricingStatus: PricingStatus
  rateLimit?: AIRateLimitSnapshot
}

export interface ModelPricing {
  provider: AIUsageProvider
  model: string
  displayName: string
  inputPricePerMillionTokens?: number
  outputPricePerMillionTokens?: number
  cachedInputPricePerMillionTokens?: number
  cacheWriteInputPricePerMillionTokens?: number
  effectiveDate: string
  lastUpdated: string
  sourceUrl: string
  status: PricingStatus
  contextWindow?: number
  maxOutputTokens?: number
}

export interface AICostEstimate {
  provider: AIUsageProvider
  model: string
  inputTokens: number
  expectedOutputTokens: number
  estimatedInputCost?: number
  estimatedOutputCost?: number
  estimatedTotalCost?: number
  currency: 'USD'
  pricingStatus: PricingStatus
  pricingSource: string
  estimated: true
}

export interface AIUsageQuery {
  startAt?: number
  endAt?: number
  provider?: AIUsageProvider
  model?: string
  mode?: AIUsageMode
  feature?: AIUsageFeature
  conversationId?: string
  projectId?: string
  agentRunId?: string
  granularity?: 'hour' | 'day' | 'week' | 'month'
  limit?: number
}

export interface AIUsageTotals {
  requests: number
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  estimatedCost?: number
  pricedRequests: number
  unpricedRequests: number
  successfulRequests: number
  failedRequests: number
  averageLatencyMs?: number
}

export interface AIUsageBreakdown extends AIUsageTotals {
  key: string
  label: string
  provider?: AIUsageProvider
  local: boolean
  percentage: number
}

export interface AIUsageTimePoint extends AIUsageTotals {
  startAt: number
  label: string
}

export type AIUsageRetention = 30 | 90 | 365 | 'forever'

export interface AIUsageBudgetSettings {
  dailyUsd?: number
  weeklyUsd?: number
  monthlyUsd?: number
  warningThresholds: number[]
  hardStop: boolean
  largeRequestWarningUsd: number
}

export interface AIUsageSettings {
  retentionDays: AIUsageRetention
  budgets: AIUsageBudgetSettings
}

export interface AIUsageBudgetWindowStatus {
  window: 'daily' | 'weekly' | 'monthly'
  limitUsd?: number
  usedUsd: number
  remainingUsd?: number
  percentage?: number
  warningThreshold?: number
  reached: boolean
  hasUnpricedUsage: boolean
  resetsAt: number
}

export interface AIUsageBudgetStatus {
  hardStop: boolean
  windows: AIUsageBudgetWindowStatus[]
  authoritativeDisclaimer: string
}

export interface AIUsageSummary {
  startAt: number
  endAt: number
  totals: AIUsageTotals
  local: AIUsageTotals
  cloud: AIUsageTotals
  localPercentage: number
  cloudPercentage: number
  timeSeries: AIUsageTimePoint[]
  providers: AIUsageBreakdown[]
  models: AIUsageBreakdown[]
  modes: AIUsageBreakdown[]
  features: AIUsageBreakdown[]
  projects: AIUsageBreakdown[]
  conversations: AIUsageBreakdown[]
  agentRuns: AIUsageBreakdown[]
  recent: AIUsageRecord[]
  budget: AIUsageBudgetStatus
  settings: AIUsageSettings
  pricingCatalogVersion: string
  pricingLastUpdated: string
  disclaimer: string
}

export type AIUsageExportFormat = 'csv' | 'json'

export interface AIUsageExportResult {
  cancelled: boolean
  path?: string
  recordCount?: number
}

export interface AIUsageDeleteResult {
  cancelled?: boolean
  deletedRecords: number
}
