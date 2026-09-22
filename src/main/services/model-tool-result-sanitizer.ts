import type { JsonValue } from '../../shared/tool-contracts'

export const MODEL_TOOL_RESULT_MAX_BYTES = 256 * 1024

const MAX_DEPTH = 32
const MAX_NODES = 20_000
const MAX_COLLECTION_ENTRIES = 4_096
const MAX_STRING_CHARACTERS = 128 * 1024
const REDACTED = '[REDACTED_SECRET]'
const TRUNCATED = '[TRUNCATED]'

type SecretContext = 'none' | 'named-values' | 'all-values'

const SENSITIVE_SCALAR_KEYS = new Set([
  'api_key',
  'apikey',
  'auth_token',
  'authorization',
  'aws_secret_access_key',
  'bearer_token',
  'client_secret',
  'cookie',
  'csrf_token',
  'id_token',
  'keychain_password',
  'keychain_secret',
  'keychain_value',
  'passcode',
  'passphrase',
  'passwd',
  'password',
  'private_key',
  'proxy_authorization',
  'refresh_token',
  'secret',
  'session_cookie',
  'session_id',
  'session_token',
  'set_cookie',
  'signing_key',
  'token',
  'x_api_key'
])

const NAMED_SECRET_CONTAINERS = new Set([
  'auth',
  'credential',
  'credentials',
  'keychain',
  'keychain_item',
  'keychain_record'
])

const ALL_SECRET_CONTAINERS = new Set([
  'cookie_jar',
  'cookies',
  'secret_store',
  'secrets'
])

const GENERIC_SECRET_VALUE_KEYS = new Set([
  'content',
  'data',
  'payload',
  'raw',
  'raw_value',
  'value'
])

const LABELED_SECRET = /(\b(?:authorization|proxy[-_ ]?authorization|api[-_ ]?key|x-api-key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|auth[-_ ]?token|bearer[-_ ]?token|client[-_ ]?secret|aws[-_ ]?secret[-_ ]?access[-_ ]?key|password|passwd|passcode|passphrase|private[-_ ]?key|signing[-_ ]?key|session[-_ ]?(?:id|token|cookie)|csrf[-_ ]?token|keychain[-_ ]?(?:password|secret|value)|secret)\b["']?\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;}\]&#]+)/giu

const COOKIE_HEADER = /(\b(?:set-cookie|cookie)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/giu

const URL_SECRET_PARAMETER = /([?&#](?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|token|signature|x-amz-credential|x-amz-signature)=)[^&#\s"']+/giu

const KNOWN_SECRET_VALUES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/gu,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{12,}\b/gu,
  /\bAIza[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:AQ\.|ya29\.)[A-Za-z0-9_-]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{12,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bnpm_[A-Za-z0-9]{16,}\b/gu,
  /\bhf_[A-Za-z0-9]{24,}\b/gu,
  /\bSG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:rk|sk)_live_[A-Za-z0-9]{12,}\b/gu
]

function normalizedKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase()
}

function isSensitiveScalarKey(key: string): boolean {
  const normalized = normalizedKey(key)
  if (SENSITIVE_SCALAR_KEYS.has(normalized)) return true
  return /(?:^|_)(?:api_key|access_token|refresh_token|id_token|auth_token|bearer_token|client_secret|password|passwd|passcode|passphrase|private_key|signing_key|session_token|session_cookie|csrf_token)$/u.test(normalized)
}

function contextForKey(key: string): SecretContext {
  const normalized = normalizedKey(key)
  if (ALL_SECRET_CONTAINERS.has(normalized)) return 'all-values'
  if (NAMED_SECRET_CONTAINERS.has(normalized)) return 'named-values'
  return 'none'
}

function redactText(value: string): string {
  const truncated = value.length > MAX_STRING_CHARACTERS
  let output = value.slice(0, MAX_STRING_CHARACTERS)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu, REDACTED)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, `$1${REDACTED}@`)
    .replace(COOKIE_HEADER, `$1${REDACTED}`)
    .replace(LABELED_SECRET, `$1${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}=*/giu, `$1 ${REDACTED}`)
    .replace(URL_SECRET_PARAMETER, `$1${REDACTED}`)

  for (const pattern of KNOWN_SECRET_VALUES) output = output.replace(pattern, REDACTED)
  output = output.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
  return truncated ? `${output}${TRUNCATED}` : output
}

/**
 * Removes credentials from arbitrary tool output before it can be included in
 * a provider request. This boundary is deliberately independent of activity
 * history redaction: tool output may contain nested structured secrets that
 * are never persisted but would otherwise be returned to the model.
 */
export function sanitizeToolResultForModel(value: JsonValue): JsonValue {
  const active = new WeakSet<object>()
  let nodes = 0

  const visit = (entry: unknown, key: string | undefined, context: SecretContext, depth: number): JsonValue => {
    nodes++
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return TRUNCATED

    const normalized = key === undefined ? '' : normalizedKey(key)
    const keyIsSensitive = key !== undefined && isSensitiveScalarKey(key)
    const contextProtectsValue = context === 'all-values' ||
      (context === 'named-values' && (key === undefined || GENERIC_SECRET_VALUE_KEYS.has(normalized)))

    if (entry === null) return keyIsSensitive || contextProtectsValue ? REDACTED : null
    if (typeof entry === 'string') {
      return keyIsSensitive || contextProtectsValue ? REDACTED : redactText(entry)
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('The connected-app result contains a non-finite number.')
      return keyIsSensitive || contextProtectsValue ? REDACTED : entry
    }
    if (typeof entry === 'boolean') return keyIsSensitive || contextProtectsValue ? REDACTED : entry
    if (!entry || typeof entry !== 'object') throw new Error('The connected-app result contains a non-JSON value.')
    if (active.has(entry)) throw new Error('The connected-app result contains a circular reference.')

    active.add(entry)
    try {
      const inheritedContext = keyIsSensitive ? 'all-values' : contextForKey(key ?? '')
      const childContext = inheritedContext === 'none' ? context : inheritedContext
      if (Array.isArray(entry)) {
        const limited = entry.slice(0, MAX_COLLECTION_ENTRIES).map((item) => visit(item, undefined, childContext, depth + 1))
        if (entry.length > MAX_COLLECTION_ENTRIES) limited.push(TRUNCATED)
        return limited
      }

      const pairs: Array<[string, JsonValue]> = []
      const usedKeys = new Set<string>()
      const entries = Object.entries(entry).slice(0, MAX_COLLECTION_ENTRIES)
      for (const [property, propertyValue] of entries) {
        let safeProperty = redactText(property)
        if (!safeProperty) safeProperty = '[REDACTED_KEY]'
        while (usedKeys.has(safeProperty)) safeProperty = `${safeProperty}_`
        usedKeys.add(safeProperty)
        pairs.push([safeProperty, visit(propertyValue, property, childContext, depth + 1)])
      }
      if (Object.keys(entry).length > MAX_COLLECTION_ENTRIES) pairs.push(['__omnicode_truncated__', true])
      return Object.fromEntries(pairs)
    } finally {
      active.delete(entry)
    }
  }

  return visit(value, undefined, 'none', 0)
}

export function serializeToolResultForModel(
  value: JsonValue,
  maximumBytes = MODEL_TOOL_RESULT_MAX_BYTES
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MODEL_TOOL_RESULT_MAX_BYTES) {
    throw new Error('The model tool-result size limit is invalid.')
  }
  let serialized: string
  try {
    serialized = JSON.stringify({ ok: true, result: sanitizeToolResultForModel(value) })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The connected-app result')) throw error
    throw new Error('The connected-app result could not be serialized safely.')
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error('The connected-app result is too large to return to the AI model.')
  }
  return serialized
}
