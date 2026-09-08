import { constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export type DiagnosticCategory =
  | 'authentication'
  | 'cancelled'
  | 'conflict'
  | 'external'
  | 'internal'
  | 'network'
  | 'not-found'
  | 'permission'
  | 'rate-limit'
  | 'timeout'
  | 'validation'

export type DiagnosticLevel = 'error' | 'info' | 'warning'

export interface DiagnosticRecord {
  timestamp: string
  level: DiagnosticLevel
  subsystem: string
  operation: string
  category: DiagnosticCategory | 'lifecycle'
  message: string
}

interface DiagnosticLoggerOptions {
  maxBytes?: number
  now?: () => Date
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_ANTHROPIC_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_API_KEY]'],
  [/\bAIza[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED_GOOGLE_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{12,}\b/gu, '[REDACTED_GITHUB_TOKEN]'],
  [/(\bauthorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/giu, '$1[REDACTED]'],
  [/(\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]'],
  [/([?&](?:api[_-]?key|access[_-]?token|key|token)=)[^&#\s]+/giu, '$1[REDACTED]'],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@']
]

function safeField(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._:-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return normalized.slice(0, 80) || fallback
}

export function redactDiagnosticMessage(value: unknown): string {
  let message = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  for (const [pattern, replacement] of SECRET_PATTERNS) message = message.replace(pattern, replacement)
  message = message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return message.slice(0, 1_000) || 'No error details were provided.'
}

export function categorizeDiagnostic(value: unknown): DiagnosticCategory {
  const message = (value instanceof Error ? `${value.name} ${value.message}` : String(value)).toLowerCase()
  if (/rate.?limit|too many requests|\b429\b/u.test(message)) return 'rate-limit'
  if (/timed?\s*out|timeout|etimedout/u.test(message)) return 'timeout'
  if (/cancel(?:led|ed)|aborted?/u.test(message)) return 'cancelled'
  if (/authentication|unauthori[sz]ed|(?:invalid|no|missing) (?:api )?key|credential|\b401\b/u.test(message)) return 'authentication'
  if (/eacces|eperm|permission denied|read.?only|not permitted|blocked access|outside (?:the )?(?:current )?workspace/u.test(message)) return 'permission'
  if (/conflict|changed on disk|stale|modified externally/u.test(message)) return 'conflict'
  if (/fetch failed|network|offline|econn|enotfound|socket|dns/u.test(message)) return 'network'
  if (/enoent|not found|does not exist|unavailable path/u.test(message)) return 'not-found'
  if (/not installed|requires? (?:configuration|user action)|external requirement|service unavailable|high demand|\b503\b/u.test(message)) return 'external'
  if (/invalid|unsupported|must |choose |limited to|expected |too (?:large|long)/u.test(message)) return 'validation'
  return 'internal'
}

export class DiagnosticLogger {
  readonly logPath: string
  readonly backupPath: string
  private readonly maxBytes: number
  private readonly now: () => Date
  private queue: Promise<void> = Promise.resolve()

  constructor(logDirectory: string, options: DiagnosticLoggerOptions = {}) {
    this.logPath = path.join(logDirectory, 'omnicode.jsonl')
    this.backupPath = `${this.logPath}.1`
    this.maxBytes = Math.max(4_096, options.maxBytes ?? 512 * 1_024)
    this.now = options.now ?? (() => new Date())
  }

  lifecycle(operation: string, message: string): Promise<void> {
    return this.enqueue({
      timestamp: this.now().toISOString(),
      level: 'info',
      subsystem: 'app',
      operation: safeField(operation, 'lifecycle'),
      category: 'lifecycle',
      message: redactDiagnosticMessage(message)
    })
  }

  failure(operation: string, error: unknown): Promise<void> {
    const [subsystem = 'app'] = operation.split(':', 1)
    return this.enqueue({
      timestamp: this.now().toISOString(),
      level: 'error',
      subsystem: safeField(subsystem, 'app'),
      operation: safeField(operation, 'unknown'),
      category: categorizeDiagnostic(error),
      message: redactDiagnosticMessage(error)
    })
  }

  flush(): Promise<void> {
    return this.queue
  }

  private enqueue(record: DiagnosticRecord): Promise<void> {
    const operation = this.queue.then(() => this.write(record))
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private async write(record: DiagnosticRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const lineBytes = Buffer.byteLength(line)
    await fs.mkdir(path.dirname(this.logPath), { recursive: true, mode: 0o700 })
    let currentBytes = 0
    try {
      const status = await fs.lstat(this.logPath)
      if (!status.isFile() || status.isSymbolicLink()) throw new Error('The diagnostic log path is not a regular file.')
      currentBytes = status.size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (currentBytes > 0 && currentBytes + lineBytes > this.maxBytes) {
      await fs.rm(this.backupPath, { force: true })
      await fs.rename(this.logPath, this.backupPath)
      await fs.chmod(this.backupPath, 0o600)
    }
    const handle = await fs.open(
      this.logPath,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await handle.writeFile(line, 'utf8')
      await handle.chmod(0o600)
    } finally {
      await handle.close()
    }
  }
}
