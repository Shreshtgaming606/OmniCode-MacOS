import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import type {
  AICostEstimate,
  AIProviderUsageMetadata,
  AIRateLimitSnapshot,
  AIUsageBreakdown,
  AIUsageBudgetSettings,
  AIUsageBudgetStatus,
  AIUsageBudgetWindowStatus,
  AIUsageContext,
  AIUsageExportFormat,
  AIUsageProvider,
  AIUsageQuery,
  AIUsageRecord,
  AIUsageSettings,
  AIUsageSummary,
  AIUsageTimePoint,
  AIUsageTotals,
  ModelPricing
} from '../../shared/ai-usage-contracts'
import {
  AI_PRICING_CATALOG_VERSION,
  AI_PRICING_LAST_UPDATED,
  BUNDLED_MODEL_PRICING,
  calculateUsageCost,
  estimateCost
} from './ai-pricing-catalog'

const SCHEMA_VERSION = 1
const DISCLAIMER = 'Estimated from model usage and published API pricing. Provider billing is authoritative.'
const IDENTIFIER_PATTERN = /^[^\0\r\n]{1,256}$/u
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u
const DEFAULT_SETTINGS: AIUsageSettings = {
  retentionDays: 365,
  budgets: {
    warningThresholds: [75, 90, 100],
    hardStop: false,
    largeRequestWarningUsd: 0.25
  }
}

interface UsageInvocation {
  provider: AIUsageProvider
  model: string
  context: AIUsageContext
  usage?: AIProviderUsageMetadata
  latencyMs: number
  success: boolean
  errorType?: string
  rateLimit?: AIRateLimitSnapshot
}

type DatabaseRow = Record<string, string | number | bigint | null>

export class AIUsageBudgetExceededError extends Error {
  constructor(
    readonly window: AIUsageBudgetWindowStatus,
    message = `${window.window[0].toUpperCase()}${window.window.slice(1)} AI budget reached. $${window.usedUsd.toFixed(2)} / $${window.limitUsd?.toFixed(2) ?? '—'}. Use a local model or change the budget.`
  ) {
    super(message)
    this.name = 'AIUsageBudgetExceededError'
  }
}

export class AIUsageBudgetUnavailableError extends Error {
  constructor(message = 'Cloud AI is paused because the hard budget is enabled and OmniCode cannot reliably price all current-period usage. Review Usage & Cost or use a local model.') {
    super(message)
    this.name = 'AIUsageBudgetUnavailableError'
  }
}

function optionalIdentifier(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`The AI usage ${name} is invalid.`)
  return value
}

function token(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function settingsCopy(settings: AIUsageSettings): AIUsageSettings {
  return {
    retentionDays: settings.retentionDays,
    budgets: { ...settings.budgets, warningThresholds: [...settings.budgets.warningThresholds] }
  }
}

function validBudget(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new Error('AI budgets must be positive USD values no greater than $1,000,000.')
  }
  return Math.round(value * 100) / 100
}

function normalizeSettings(value: Partial<AIUsageSettings> | undefined): AIUsageSettings {
  const retention = value?.retentionDays ?? DEFAULT_SETTINGS.retentionDays
  if (retention !== 'forever' && ![30, 90, 365].includes(retention)) throw new Error('Choose a supported AI usage retention period.')
  const budgets = value?.budgets
  const warningThresholds = budgets?.warningThresholds ?? DEFAULT_SETTINGS.budgets.warningThresholds
  if (!Array.isArray(warningThresholds) || !warningThresholds.length || warningThresholds.length > 8 || warningThresholds.some((item) => !Number.isFinite(item) || item <= 0 || item > 100)) {
    throw new Error('Budget warning thresholds must be percentages from 1 through 100.')
  }
  const largeRequestWarningUsd = budgets?.largeRequestWarningUsd ?? DEFAULT_SETTINGS.budgets.largeRequestWarningUsd
  if (!Number.isFinite(largeRequestWarningUsd) || largeRequestWarningUsd < 0 || largeRequestWarningUsd > 10_000) {
    throw new Error('The large-request warning amount is invalid.')
  }
  return {
    retentionDays: retention,
    budgets: {
      dailyUsd: validBudget(budgets?.dailyUsd),
      weeklyUsd: validBudget(budgets?.weeklyUsd),
      monthlyUsd: validBudget(budgets?.monthlyUsd),
      warningThresholds: [...new Set(warningThresholds.map((item) => Math.round(item * 100) / 100))].sort((a, b) => a - b),
      hardStop: budgets?.hardStop === true,
      largeRequestWarningUsd: Math.round(largeRequestWarningUsd * 10_000) / 10_000
    }
  }
}

function number(row: DatabaseRow, key: string): number {
  const value = row[key]
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0
}

function optionalNumber(row: DatabaseRow, key: string, countKey?: string): number | undefined {
  if (countKey && number(row, countKey) === 0) return undefined
  const value = row[key]
  if (value === null || value === undefined) return undefined
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : undefined
}

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function localWeekStart(timestamp: number): number {
  const date = new Date(localDayStart(timestamp))
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return date.getTime()
}

function localMonthStart(timestamp: number): number {
  const date = new Date(timestamp)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function nextDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

function nextWeek(timestamp: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + 7)
  return date.getTime()
}

function nextMonth(timestamp: number): number {
  const date = new Date(timestamp)
  date.setMonth(date.getMonth() + 1)
  return date.getTime()
}

function safeRateLimit(value: unknown): AIRateLimitSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<AIRateLimitSnapshot>
  if (!['healthy', 'limited', 'unknown'].includes(String(record.status))) return undefined
  return {
    status: record.status as AIRateLimitSnapshot['status'],
    requestsRemaining: token(record.requestsRemaining),
    tokensRemaining: token(record.tokensRemaining),
    resetAt: typeof record.resetAt === 'string' && record.resetAt.length <= 128 ? record.resetAt : undefined,
    retryAfterSeconds: typeof record.retryAfterSeconds === 'number' && Number.isFinite(record.retryAfterSeconds) && record.retryAfterSeconds >= 0
      ? record.retryAfterSeconds
      : undefined
  }
}

function rowToRecord(row: DatabaseRow): AIUsageRecord {
  let rateLimit: AIRateLimitSnapshot | undefined
  if (typeof row.rate_limit_json === 'string' && row.rate_limit_json) {
    try { rateLimit = safeRateLimit(JSON.parse(row.rate_limit_json)) } catch { rateLimit = undefined }
  }
  return {
    id: String(row.id),
    schemaVersion: 1,
    timestamp: number(row, 'timestamp'),
    provider: String(row.provider) as AIUsageProvider,
    model: String(row.model),
    mode: String(row.mode) as AIUsageRecord['mode'],
    feature: String(row.feature) as AIUsageRecord['feature'],
    usageType: String(row.usage_type) as AIUsageRecord['usageType'],
    conversationId: row.conversation_id === null ? undefined : String(row.conversation_id),
    projectId: row.project_id === null ? undefined : String(row.project_id),
    agentRunId: row.agent_run_id === null ? undefined : String(row.agent_run_id),
    taskId: row.task_id === null ? undefined : String(row.task_id),
    inputTokens: optionalNumber(row, 'input_tokens'),
    outputTokens: optionalNumber(row, 'output_tokens'),
    cachedInputTokens: optionalNumber(row, 'cached_input_tokens'),
    cacheWriteInputTokens: optionalNumber(row, 'cache_write_input_tokens'),
    reasoningTokens: optionalNumber(row, 'reasoning_tokens'),
    totalTokens: optionalNumber(row, 'total_tokens'),
    requestCount: 1,
    estimatedInputCost: optionalNumber(row, 'estimated_input_cost'),
    estimatedOutputCost: optionalNumber(row, 'estimated_output_cost'),
    estimatedCachedCost: optionalNumber(row, 'estimated_cached_cost'),
    estimatedCacheWriteCost: optionalNumber(row, 'estimated_cache_write_cost'),
    estimatedTotalCost: optionalNumber(row, 'estimated_total_cost'),
    currency: 'USD',
    latencyMs: number(row, 'latency_ms'),
    success: number(row, 'success') === 1,
    errorType: row.error_type === null ? undefined : String(row.error_type),
    localModel: number(row, 'local_model') === 1,
    pricingSource: String(row.pricing_source),
    pricingVersion: String(row.pricing_version),
    pricingStatus: String(row.pricing_status) as AIUsageRecord['pricingStatus'],
    rateLimit
  }
}

function csv(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

export class AIUsageManager {
  readonly #database: DatabaseSync
  readonly #now: () => number

  constructor(
    databasePath: string,
    options: { now?: () => number } = {}
  ) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    this.#database = new DatabaseSync(databasePath)
    this.#now = options.now ?? (() => Date.now())
    this.#migrate()
    try { chmodSync(databasePath, 0o600) } catch { /* Best effort on non-POSIX test hosts. */ }
  }

  #migrate(): void {
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS ai_usage_records (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        feature TEXT NOT NULL,
        usage_type TEXT NOT NULL,
        conversation_id TEXT,
        project_id TEXT,
        agent_run_id TEXT,
        task_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        estimated_input_cost REAL,
        estimated_output_cost REAL,
        estimated_cached_cost REAL,
        estimated_cache_write_cost REAL,
        estimated_total_cost REAL,
        currency TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        error_type TEXT,
        local_model INTEGER NOT NULL,
        pricing_source TEXT NOT NULL,
        pricing_version TEXT NOT NULL,
        pricing_status TEXT NOT NULL,
        rate_limit_json TEXT
      );
      CREATE INDEX IF NOT EXISTS ai_usage_timestamp_idx ON ai_usage_records(timestamp);
      CREATE INDEX IF NOT EXISTS ai_usage_provider_timestamp_idx ON ai_usage_records(provider, timestamp);
      CREATE INDEX IF NOT EXISTS ai_usage_model_timestamp_idx ON ai_usage_records(model, timestamp);
      CREATE INDEX IF NOT EXISTS ai_usage_mode_timestamp_idx ON ai_usage_records(mode, timestamp);
      CREATE INDEX IF NOT EXISTS ai_usage_conversation_idx ON ai_usage_records(conversation_id, timestamp);
      CREATE INDEX IF NOT EXISTS ai_usage_agent_run_idx ON ai_usage_records(agent_run_id, timestamp);
      CREATE TABLE IF NOT EXISTS ai_usage_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
    const existing = this.#database.prepare('SELECT value_json FROM ai_usage_settings WHERE id = 1').get() as DatabaseRow | undefined
    if (!existing) {
      this.#database.prepare('INSERT INTO ai_usage_settings(id, value_json, updated_at) VALUES (1, ?, ?)')
        .run(JSON.stringify(DEFAULT_SETTINGS), this.#now())
    }
  }

  close(): void {
    this.#database.close()
  }

  pricingCatalog(): ModelPricing[] {
    return BUNDLED_MODEL_PRICING.map((entry) => ({ ...entry }))
  }

  estimateRequest(input: { provider: AIUsageProvider; model: string; inputTokens: number; expectedOutputTokens: number }): AICostEstimate {
    return estimateCost(input)
  }

  record(invocation: UsageInvocation): AIUsageRecord {
    if (!['ollama', 'openai', 'anthropic', 'google'].includes(invocation.provider)) throw new Error('The AI usage provider is invalid.')
    if (!MODEL_PATTERN.test(invocation.model)) throw new Error('The AI usage model is invalid.')
    const usage: AIProviderUsageMetadata = {
      inputTokens: token(invocation.usage?.inputTokens),
      outputTokens: token(invocation.usage?.outputTokens),
      cachedInputTokens: token(invocation.usage?.cachedInputTokens),
      cacheWriteInputTokens: token(invocation.usage?.cacheWriteInputTokens),
      reasoningTokens: token(invocation.usage?.reasoningTokens),
      totalTokens: token(invocation.usage?.totalTokens)
    }
    if (usage.totalTokens === undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
      usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    }
    const calculated = calculateUsageCost(invocation.provider, invocation.model, usage)
    const localModel = invocation.provider === 'ollama'
    const context: AIUsageContext = {
      ...invocation.context,
      conversationId: optionalIdentifier(invocation.context.conversationId, 'conversation identifier'),
      projectId: optionalIdentifier(invocation.context.projectId, 'project identifier'),
      agentRunId: optionalIdentifier(invocation.context.agentRunId, 'agent run identifier'),
      taskId: optionalIdentifier(invocation.context.taskId, 'task identifier')
    }
    const record: AIUsageRecord = {
      id: randomUUID(),
      schemaVersion: 1,
      timestamp: this.#now(),
      provider: invocation.provider,
      model: invocation.model,
      mode: context.mode,
      feature: context.feature,
      usageType: context.usageType ?? 'TEXT_AI',
      conversationId: context.conversationId,
      projectId: context.projectId,
      agentRunId: context.agentRunId,
      taskId: context.taskId,
      ...usage,
      requestCount: 1,
      estimatedInputCost: calculated.estimatedInputCost,
      estimatedOutputCost: calculated.estimatedOutputCost,
      estimatedCachedCost: calculated.estimatedCachedCost,
      estimatedCacheWriteCost: calculated.estimatedCacheWriteCost,
      estimatedTotalCost: calculated.estimatedTotalCost,
      currency: 'USD',
      latencyMs: Math.max(0, Math.round(invocation.latencyMs)),
      success: invocation.success,
      errorType: invocation.errorType?.slice(0, 128),
      localModel,
      pricingSource: calculated.pricing?.sourceUrl ?? 'Pricing unavailable',
      pricingVersion: AI_PRICING_CATALOG_VERSION,
      pricingStatus: calculated.pricing?.status ?? 'UNKNOWN',
      rateLimit: safeRateLimit(invocation.rateLimit)
    }
    this.#database.prepare(`
      INSERT INTO ai_usage_records (
        id, schema_version, timestamp, provider, model, mode, feature, usage_type,
        conversation_id, project_id, agent_run_id, task_id,
        input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens,
        reasoning_tokens, total_tokens,
        estimated_input_cost, estimated_output_cost, estimated_cached_cost,
        estimated_cache_write_cost, estimated_total_cost, currency, latency_ms,
        success, error_type, local_model, pricing_source, pricing_version,
        pricing_status, rate_limit_json
      ) VALUES (${Array.from({ length: 32 }, () => '?').join(', ')})
    `).run(
      record.id, record.schemaVersion, record.timestamp, record.provider, record.model,
      record.mode, record.feature, record.usageType, record.conversationId ?? null,
      record.projectId ?? null, record.agentRunId ?? null, record.taskId ?? null,
      record.inputTokens ?? null, record.outputTokens ?? null, record.cachedInputTokens ?? null,
      record.cacheWriteInputTokens ?? null, record.reasoningTokens ?? null, record.totalTokens ?? null,
      record.estimatedInputCost ?? null, record.estimatedOutputCost ?? null,
      record.estimatedCachedCost ?? null, record.estimatedCacheWriteCost ?? null,
      record.estimatedTotalCost ?? null, record.currency, record.latencyMs,
      record.success ? 1 : 0, record.errorType ?? null, record.localModel ? 1 : 0,
      record.pricingSource, record.pricingVersion, record.pricingStatus,
      record.rateLimit ? JSON.stringify(record.rateLimit) : null
    )
    return record
  }

  settings(): AIUsageSettings {
    const row = this.#database.prepare('SELECT value_json FROM ai_usage_settings WHERE id = 1').get() as DatabaseRow | undefined
    if (!row || typeof row.value_json !== 'string') return settingsCopy(DEFAULT_SETTINGS)
    try { return normalizeSettings(JSON.parse(row.value_json) as Partial<AIUsageSettings>) } catch { return settingsCopy(DEFAULT_SETTINGS) }
  }

  updateSettings(value: AIUsageSettings): AIUsageSettings {
    const normalized = normalizeSettings(value)
    this.#database.prepare('UPDATE ai_usage_settings SET value_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(normalized), this.#now())
    this.applyRetention()
    return normalized
  }

  applyRetention(): number {
    const retention = this.settings().retentionDays
    if (retention === 'forever') return 0
    const threshold = this.#now() - retention * 24 * 60 * 60 * 1_000
    const result = this.#database.prepare('DELETE FROM ai_usage_records WHERE timestamp < ?').run(threshold)
    return Number(result.changes)
  }

  deleteHistory(): number {
    const result = this.#database.prepare('DELETE FROM ai_usage_records').run()
    this.#database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    return Number(result.changes)
  }

  #where(query: AIUsageQuery = {}): { sql: string; values: SQLInputValue[] } {
    const clauses: string[] = []
    const values: SQLInputValue[] = []
    const add = (column: string, value: SQLInputValue | undefined, operator = '='): void => {
      if (value === undefined) return
      clauses.push(`${column} ${operator} ?`)
      values.push(value)
    }
    add('timestamp', query.startAt, '>=')
    add('timestamp', query.endAt, '<')
    add('provider', query.provider)
    add('model', query.model)
    add('mode', query.mode)
    add('feature', query.feature)
    add('conversation_id', query.conversationId)
    add('project_id', query.projectId)
    add('agent_run_id', query.agentRunId)
    return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values }
  }

  #totals(query: AIUsageQuery = {}): AIUsageTotals {
    const where = this.#where(query)
    const row = this.#database.prepare(`
      SELECT COUNT(*) requests,
        COUNT(input_tokens) input_count, SUM(input_tokens) input_tokens,
        COUNT(output_tokens) output_count, SUM(output_tokens) output_tokens,
        COUNT(cached_input_tokens) cached_count, SUM(cached_input_tokens) cached_input_tokens,
        COUNT(reasoning_tokens) reasoning_count, SUM(reasoning_tokens) reasoning_tokens,
        COUNT(total_tokens) total_count, SUM(total_tokens) total_tokens,
        COUNT(estimated_total_cost) priced_requests, SUM(estimated_total_cost) estimated_cost,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) failed_requests,
        AVG(latency_ms) average_latency_ms
      FROM ai_usage_records${where.sql}
    `).get(...where.values) as DatabaseRow
    const requests = number(row, 'requests')
    const pricedRequests = number(row, 'priced_requests')
    return {
      requests,
      inputTokens: optionalNumber(row, 'input_tokens', 'input_count'),
      outputTokens: optionalNumber(row, 'output_tokens', 'output_count'),
      cachedInputTokens: optionalNumber(row, 'cached_input_tokens', 'cached_count'),
      reasoningTokens: optionalNumber(row, 'reasoning_tokens', 'reasoning_count'),
      totalTokens: optionalNumber(row, 'total_tokens', 'total_count'),
      estimatedCost: optionalNumber(row, 'estimated_cost', 'priced_requests'),
      pricedRequests,
      unpricedRequests: Math.max(0, requests - pricedRequests),
      successfulRequests: number(row, 'successful_requests'),
      failedRequests: number(row, 'failed_requests'),
      averageLatencyMs: requests ? optionalNumber(row, 'average_latency_ms') : undefined
    }
  }

  #breakdown(query: AIUsageQuery, expression: string, label: (row: DatabaseRow) => string): AIUsageBreakdown[] {
    const where = this.#where(query)
    const rows = this.#database.prepare(`
      SELECT ${expression}, MIN(local_model) local_model,
        COUNT(*) requests,
        COUNT(input_tokens) input_count, SUM(input_tokens) input_tokens,
        COUNT(output_tokens) output_count, SUM(output_tokens) output_tokens,
        COUNT(cached_input_tokens) cached_count, SUM(cached_input_tokens) cached_input_tokens,
        COUNT(reasoning_tokens) reasoning_count, SUM(reasoning_tokens) reasoning_tokens,
        COUNT(total_tokens) total_count, SUM(total_tokens) total_tokens,
        COUNT(estimated_total_cost) priced_requests, SUM(estimated_total_cost) estimated_cost,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) failed_requests,
        AVG(latency_ms) average_latency_ms
      FROM ai_usage_records${where.sql}
      GROUP BY ${expression}
      ORDER BY COALESCE(SUM(estimated_total_cost), 0) DESC, COALESCE(SUM(total_tokens), 0) DESC, COUNT(*) DESC
    `).all(...where.values) as DatabaseRow[]
    const totalWeight = rows.reduce((sum, row) => sum + (number(row, 'total_tokens') || number(row, 'requests')), 0)
    return rows.map((row) => {
      const requests = number(row, 'requests')
      const pricedRequests = number(row, 'priced_requests')
      const weight = number(row, 'total_tokens') || requests
      return {
        key: label(row),
        label: label(row),
        provider: row.provider ? String(row.provider) as AIUsageProvider : undefined,
        local: number(row, 'local_model') === 1,
        percentage: totalWeight ? (weight / totalWeight) * 100 : 0,
        requests,
        inputTokens: optionalNumber(row, 'input_tokens', 'input_count'),
        outputTokens: optionalNumber(row, 'output_tokens', 'output_count'),
        cachedInputTokens: optionalNumber(row, 'cached_input_tokens', 'cached_count'),
        reasoningTokens: optionalNumber(row, 'reasoning_tokens', 'reasoning_count'),
        totalTokens: optionalNumber(row, 'total_tokens', 'total_count'),
        estimatedCost: optionalNumber(row, 'estimated_cost', 'priced_requests'),
        pricedRequests,
        unpricedRequests: Math.max(0, requests - pricedRequests),
        successfulRequests: number(row, 'successful_requests'),
        failedRequests: number(row, 'failed_requests'),
        averageLatencyMs: optionalNumber(row, 'average_latency_ms')
      }
    })
  }

  #timeSeries(query: AIUsageQuery): AIUsageTimePoint[] {
    const granularity = query.granularity ?? 'day'
    const format = granularity === 'hour'
      ? '%Y-%m-%d %H:00'
      : granularity === 'week'
        ? '%Y-W%W'
        : granularity === 'month'
          ? '%Y-%m'
          : '%Y-%m-%d'
    const where = this.#where(query)
    const rows = this.#database.prepare(`
      SELECT strftime('${format}', timestamp / 1000, 'unixepoch', 'localtime') bucket,
        MIN(timestamp) start_at, COUNT(*) requests,
        COUNT(input_tokens) input_count, SUM(input_tokens) input_tokens,
        COUNT(output_tokens) output_count, SUM(output_tokens) output_tokens,
        COUNT(cached_input_tokens) cached_count, SUM(cached_input_tokens) cached_input_tokens,
        COUNT(reasoning_tokens) reasoning_count, SUM(reasoning_tokens) reasoning_tokens,
        COUNT(total_tokens) total_count, SUM(total_tokens) total_tokens,
        COUNT(estimated_total_cost) priced_requests, SUM(estimated_total_cost) estimated_cost,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) failed_requests,
        AVG(latency_ms) average_latency_ms
      FROM ai_usage_records${where.sql}
      GROUP BY bucket ORDER BY start_at ASC
    `).all(...where.values) as DatabaseRow[]
    return rows.map((row) => {
      const requests = number(row, 'requests')
      const pricedRequests = number(row, 'priced_requests')
      return {
        startAt: number(row, 'start_at'),
        label: String(row.bucket),
        requests,
        inputTokens: optionalNumber(row, 'input_tokens', 'input_count'),
        outputTokens: optionalNumber(row, 'output_tokens', 'output_count'),
        cachedInputTokens: optionalNumber(row, 'cached_input_tokens', 'cached_count'),
        reasoningTokens: optionalNumber(row, 'reasoning_tokens', 'reasoning_count'),
        totalTokens: optionalNumber(row, 'total_tokens', 'total_count'),
        estimatedCost: optionalNumber(row, 'estimated_cost', 'priced_requests'),
        pricedRequests,
        unpricedRequests: Math.max(0, requests - pricedRequests),
        successfulRequests: number(row, 'successful_requests'),
        failedRequests: number(row, 'failed_requests'),
        averageLatencyMs: optionalNumber(row, 'average_latency_ms')
      }
    })
  }

  records(query: AIUsageQuery = {}): AIUsageRecord[] {
    const where = this.#where(query)
    const limit = Math.min(500, Math.max(1, Math.round(query.limit ?? 100)))
    const rows = this.#database.prepare(`SELECT * FROM ai_usage_records${where.sql} ORDER BY timestamp DESC LIMIT ?`)
      .all(...where.values, limit) as DatabaseRow[]
    return rows.map(rowToRecord)
  }

  budgetStatus(now = this.#now()): AIUsageBudgetStatus {
    const settings = this.settings()
    const windows: Array<{ window: AIUsageBudgetWindowStatus['window']; start: number; end: number; limit?: number }> = [
      { window: 'daily', start: localDayStart(now), end: nextDay(localDayStart(now)), limit: settings.budgets.dailyUsd },
      { window: 'weekly', start: localWeekStart(now), end: nextWeek(localWeekStart(now)), limit: settings.budgets.weeklyUsd },
      { window: 'monthly', start: localMonthStart(now), end: nextMonth(localMonthStart(now)), limit: settings.budgets.monthlyUsd }
    ]
    return {
      hardStop: settings.budgets.hardStop,
      authoritativeDisclaimer: DISCLAIMER,
      windows: windows.map((item) => {
        const where = this.#where({ startAt: item.start, endAt: item.end })
        const row = this.#database.prepare(`
          SELECT COALESCE(SUM(estimated_total_cost), 0) used,
            SUM(CASE WHEN local_model = 0 AND estimated_total_cost IS NULL THEN 1 ELSE 0 END) unpriced
          FROM ai_usage_records${where.sql}
        `).get(...where.values) as DatabaseRow
        const usedUsd = money(optionalNumber(row, 'used')) ?? 0
        const percentage = item.limit ? (usedUsd / item.limit) * 100 : undefined
        const warningThreshold = percentage === undefined
          ? undefined
          : [...settings.budgets.warningThresholds].reverse().find((threshold) => percentage >= threshold)
        return {
          window: item.window,
          limitUsd: item.limit,
          usedUsd,
          remainingUsd: item.limit === undefined ? undefined : Math.max(0, item.limit - usedUsd),
          percentage,
          warningThreshold,
          reached: item.limit !== undefined && usedUsd >= item.limit,
          hasUnpricedUsage: number(row, 'unpriced') > 0,
          resetsAt: item.end
        }
      })
    }
  }

  assertWithinBudget(estimate: AICostEstimate): void {
    if (estimate.provider === 'ollama') return
    const status = this.budgetStatus()
    if (!status.hardStop) return
    const configured = status.windows.filter((window) => window.limitUsd !== undefined)
    if (!configured.length) return
    if (estimate.estimatedTotalCost === undefined || configured.some((window) => window.hasUnpricedUsage)) {
      throw new AIUsageBudgetUnavailableError()
    }
    for (const window of configured) {
      if ((window.usedUsd + estimate.estimatedTotalCost) > (window.limitUsd ?? Number.POSITIVE_INFINITY)) {
        throw new AIUsageBudgetExceededError({
          ...window,
          usedUsd: window.usedUsd + estimate.estimatedTotalCost,
          percentage: window.limitUsd ? ((window.usedUsd + estimate.estimatedTotalCost) / window.limitUsd) * 100 : undefined,
          reached: true
        })
      }
    }
  }

  summary(query: AIUsageQuery = {}): AIUsageSummary {
    this.applyRetention()
    const endAt = query.endAt ?? this.#now() + 1
    const startAt = query.startAt ?? 0
    const normalized = { ...query, startAt, endAt }
    const totals = this.#totals(normalized)
    const local = this.#totals({ ...normalized, provider: 'ollama' })
    const cloudQuery = this.#where(normalized)
    const cloudTotalsRow = this.#database.prepare(`
      SELECT COUNT(*) requests,
        COUNT(input_tokens) input_count, SUM(input_tokens) input_tokens,
        COUNT(output_tokens) output_count, SUM(output_tokens) output_tokens,
        COUNT(cached_input_tokens) cached_count, SUM(cached_input_tokens) cached_input_tokens,
        COUNT(reasoning_tokens) reasoning_count, SUM(reasoning_tokens) reasoning_tokens,
        COUNT(total_tokens) total_count, SUM(total_tokens) total_tokens,
        COUNT(estimated_total_cost) priced_requests, SUM(estimated_total_cost) estimated_cost,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) failed_requests,
        AVG(latency_ms) average_latency_ms
      FROM ai_usage_records${cloudQuery.sql}${cloudQuery.sql ? ' AND' : ' WHERE'} local_model = 0
    `).get(...cloudQuery.values) as DatabaseRow
    const cloudRequests = number(cloudTotalsRow, 'requests')
    const cloudPriced = number(cloudTotalsRow, 'priced_requests')
    const cloud: AIUsageTotals = {
      requests: cloudRequests,
      inputTokens: optionalNumber(cloudTotalsRow, 'input_tokens', 'input_count'),
      outputTokens: optionalNumber(cloudTotalsRow, 'output_tokens', 'output_count'),
      cachedInputTokens: optionalNumber(cloudTotalsRow, 'cached_input_tokens', 'cached_count'),
      reasoningTokens: optionalNumber(cloudTotalsRow, 'reasoning_tokens', 'reasoning_count'),
      totalTokens: optionalNumber(cloudTotalsRow, 'total_tokens', 'total_count'),
      estimatedCost: optionalNumber(cloudTotalsRow, 'estimated_cost', 'priced_requests'),
      pricedRequests: cloudPriced,
      unpricedRequests: Math.max(0, cloudRequests - cloudPriced),
      successfulRequests: number(cloudTotalsRow, 'successful_requests'),
      failedRequests: number(cloudTotalsRow, 'failed_requests'),
      averageLatencyMs: optionalNumber(cloudTotalsRow, 'average_latency_ms')
    }
    const shareTotal = (local.totalTokens ?? 0) + (cloud.totalTokens ?? 0) || local.requests + cloud.requests
    const localWeight = local.totalTokens ?? local.requests
    const providerLabels: Record<AIUsageProvider, string> = { ollama: 'Ollama', openai: 'OpenAI', anthropic: 'Anthropic Claude', google: 'Google Gemini' }
    const providers = this.#breakdown(normalized, 'provider', (row) => providerLabels[String(row.provider) as AIUsageProvider] ?? String(row.provider))
    return {
      startAt,
      endAt,
      totals,
      local,
      cloud,
      localPercentage: shareTotal ? (localWeight / shareTotal) * 100 : 0,
      cloudPercentage: shareTotal ? 100 - (localWeight / shareTotal) * 100 : 0,
      timeSeries: this.#timeSeries(normalized),
      providers,
      models: this.#breakdown(normalized, 'provider, model', (row) => `${String(row.provider)} · ${String(row.model)}`),
      modes: this.#breakdown(normalized, 'mode', (row) => String(row.mode)),
      features: this.#breakdown(normalized, 'feature', (row) => String(row.feature)),
      projects: this.#breakdown(normalized, 'project_id', (row) => row.project_id ? `Project ${String(row.project_id).slice(0, 8)}` : 'No project'),
      conversations: this.#breakdown(normalized, 'conversation_id', (row) => row.conversation_id ? `Conversation ${String(row.conversation_id).slice(0, 8)}` : 'No conversation'),
      agentRuns: this.#breakdown(normalized, 'agent_run_id', (row) => row.agent_run_id ? `Agent run ${String(row.agent_run_id).slice(0, 8)}` : 'No agent run'),
      recent: this.records({ ...normalized, limit: query.limit ?? 50 }),
      budget: this.budgetStatus(),
      settings: this.settings(),
      pricingCatalogVersion: AI_PRICING_CATALOG_VERSION,
      pricingLastUpdated: AI_PRICING_LAST_UPDATED,
      disclaimer: DISCLAIMER
    }
  }

  exportData(format: AIUsageExportFormat, query: AIUsageQuery = {}): { content: string; recordCount: number } {
    if (format !== 'csv' && format !== 'json') throw new Error('Choose CSV or JSON for the AI usage export.')
    const where = this.#where(query)
    const statement = this.#database.prepare(`SELECT * FROM ai_usage_records${where.sql} ORDER BY timestamp ASC`)
    const records = [...statement.iterate(...where.values) as Iterable<DatabaseRow>].map(rowToRecord)
    if (format === 'json') return { content: `${JSON.stringify(records, null, 2)}\n`, recordCount: records.length }
    const headers = [
      'timestamp', 'provider', 'model', 'mode', 'feature', 'usageType', 'conversationId', 'projectId', 'agentRunId', 'taskId',
      'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens', 'totalTokens',
      'estimatedInputCostUsd', 'estimatedOutputCostUsd', 'estimatedCachedCostUsd', 'estimatedCacheWriteCostUsd', 'estimatedTotalCostUsd',
      'latencyMs', 'success', 'errorType', 'localModel', 'pricingStatus', 'pricingVersion', 'pricingSource', 'rateLimitStatus'
    ]
    const lines = records.map((record) => [
      new Date(record.timestamp).toISOString(), record.provider, record.model, record.mode, record.feature, record.usageType,
      record.conversationId, record.projectId, record.agentRunId, record.taskId, record.inputTokens, record.outputTokens,
      record.cachedInputTokens, record.cacheWriteInputTokens, record.reasoningTokens, record.totalTokens,
      record.estimatedInputCost, record.estimatedOutputCost, record.estimatedCachedCost, record.estimatedCacheWriteCost,
      record.estimatedTotalCost, record.latencyMs, record.success, record.errorType, record.localModel,
      record.pricingStatus, record.pricingVersion, record.pricingSource, record.rateLimit?.status
    ].map(csv).join(','))
    return { content: `${headers.map(csv).join(',')}\n${lines.join('\n')}${lines.length ? '\n' : ''}`, recordCount: records.length }
  }
}
