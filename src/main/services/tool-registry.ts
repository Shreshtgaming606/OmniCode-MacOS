import type {
  JsonValue,
  ToolAuthorizationDecision,
  ToolDescriptor,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolValueSchema
} from '../../shared/tool-contracts'
import { PermissionManager, type ToolAuthorizationContext } from './permission-manager'

const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/u
const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u
const MAX_INPUT_BYTES = 64 * 1024
const DEFAULT_RESULT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

export interface ToolExecutorContext {
  mode: ToolExecutionRequest['mode']
  signal: AbortSignal
  authorization: ToolAuthorizationDecision
  executionId?: string
  reportProgress?(value: JsonValue): void
}

export type ToolExecutor = (
  input: Record<string, JsonValue>,
  context: ToolExecutorContext
) => Promise<JsonValue>

interface RegisteredTool {
  descriptor: ToolDescriptor
  executor: ToolExecutor
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
}

function validateSchema(schema: ToolValueSchema, value: unknown, path: string): JsonValue {
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} must be a string.`)
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} is too short.`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path} is too long.`)
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} is not an allowed value.`)
    if (schema.format === 'https-url') {
      let url: URL
      try { url = new URL(value) } catch { throw new Error(`${path} must be a valid HTTPS URL.`) }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${path} must be a credential-free HTTPS URL.`)
    }
    return value
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`)
    return value
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
      throw new Error(`${path} must be a finite ${schema.type}.`)
    }
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is below the allowed minimum.`)
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} exceeds the allowed maximum.`)
    return value
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`)
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} has too few items.`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path} has too many items.`)
    return value.map((item, index) => validateSchema(schema.items, item, `${path}[${index}]`))
  }
  if (schema.type !== 'object') throw new Error(`${path} uses an unsupported schema.`)
  assertRecord(value, path)
  const required = new Set(schema.required ?? [])
  for (const key of required) if (!(key in value)) throw new Error(`${path}.${key} is required.`)
  const result: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    const property = schema.properties[key]
    if (!property) throw new Error(`${path}.${key} is not supported.`)
    result[key] = validateSchema(property, entry, `${path}.${key}`)
  }
  return result
}

function validateDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  if (!TOOL_ID_PATTERN.test(descriptor.id)) throw new Error('Tool IDs must use connector.action form.')
  if (!CONNECTOR_ID_PATTERN.test(descriptor.connectorId)) throw new Error('Connector IDs contain unsupported characters.')
  if (!descriptor.name.trim() || !descriptor.description.trim()) throw new Error('Tool name and description are required.')
  if (!descriptor.modes.length || descriptor.modes.some((mode) => mode !== 'code' && mode !== 'work')) throw new Error('Tool modes are invalid.')
  if (!['read', 'write', 'destructive', 'sensitive'].includes(descriptor.action)) throw new Error('Tool action classification is invalid.')
  if (!['read', 'write', 'communication', 'destructive', 'external-submission', 'system', 'financial', 'account-security', 'sensitive-data'].includes(descriptor.category)) {
    throw new Error('Tool action category is invalid.')
  }
  if (!['low', 'medium', 'high', 'critical'].includes(descriptor.risk)) throw new Error('Tool risk classification is invalid.')
  if (typeof descriptor.reversible !== 'boolean' || typeof descriptor.externalSideEffect !== 'boolean') throw new Error('Tool side-effect metadata is invalid.')
  if (!['never', 'policy', 'always'].includes(descriptor.confirmation)) throw new Error('Tool confirmation policy is invalid.')
  if (descriptor.timeoutMs !== undefined && (!Number.isInteger(descriptor.timeoutMs) || descriptor.timeoutMs < 100 || descriptor.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new Error('Tool timeout must be between 100 and 120000 milliseconds.')
  }
  return Object.freeze({
    ...descriptor,
    modes: Object.freeze([...descriptor.modes]),
    requiredScopes: Object.freeze([...descriptor.requiredScopes])
  })
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>()

  constructor(private readonly permissions = new PermissionManager()) {}

  register(descriptor: ToolDescriptor, executor: ToolExecutor): void {
    const validated = validateDescriptor(descriptor)
    if (this.#tools.has(validated.id)) throw new Error(`Tool ${validated.id} is already registered.`)
    this.#tools.set(validated.id, { descriptor: validated, executor })
  }

  list(mode: ToolExecutionRequest['mode'], connectorId?: string): ToolDescriptor[] {
    if (mode !== 'code' && mode !== 'work') throw new Error('Choose a supported OmniCode mode.')
    return [...this.#tools.values()]
      .map((entry) => entry.descriptor)
      .filter((tool) => tool.modes.includes(mode) && (!connectorId || tool.connectorId === connectorId))
      .map((tool) => ({ ...tool, modes: [...tool.modes], requiredScopes: [...tool.requiredScopes] }))
  }

  async execute(
    request: ToolExecutionRequest,
    authorization: ToolAuthorizationContext,
    options: { signal?: AbortSignal; executionId?: string; onProgress?(value: JsonValue): void } = {}
  ): Promise<ToolExecutionResult> {
    const registered = this.#tools.get(request.toolId)
    if (!registered) throw new Error('The requested Work tool is not registered.')
    if (!registered.descriptor.modes.includes(request.mode)) throw new Error(`${registered.descriptor.name} is not available in ${request.mode} mode.`)
    let serializedInput: string
    try {
      serializedInput = JSON.stringify(request.input)
    } catch {
      throw new Error('The tool input must contain serializable JSON values.')
    }
    const inputBytes = Buffer.byteLength(serializedInput, 'utf8')
    if (inputBytes > MAX_INPUT_BYTES) throw new Error('The tool input exceeds the 64 KB limit.')
    const normalized = validateSchema(registered.descriptor.inputSchema, request.input, 'input')
    assertRecord(normalized, 'input')
    const authorizationDecision = await this.permissions.authorize(registered.descriptor, normalized as Record<string, JsonValue>, {
      ...authorization,
      signal: options.signal ?? authorization.signal
    })

    const controller = new AbortController()
    const abortFromCaller = (): void => controller.abort(options.signal?.reason ?? new DOMException('Tool execution cancelled.', 'AbortError'))
    if (options.signal?.aborted) abortFromCaller()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeoutMs = registered.descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timeout = setTimeout(() => controller.abort(new Error('Tool execution timed out.')), timeoutMs)
    const startedAt = new Date().toISOString()
    try {
      const aborted = controller.signal.aborted
        ? Promise.reject(controller.signal.reason)
        : new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
      const result = await Promise.race([
        registered.executor(normalized as Record<string, JsonValue>, {
          mode: request.mode,
          signal: controller.signal,
          authorization: authorizationDecision,
          executionId: options.executionId,
          reportProgress: options.onProgress
        }),
        aborted
      ])
      const checked = registered.descriptor.resultSchema
        ? validateSchema(registered.descriptor.resultSchema, result, 'result')
        : result
      let serializedResult: string
      try {
        serializedResult = JSON.stringify(checked)
      } catch {
        throw new Error('The tool returned a result that cannot be serialized safely.')
      }
      if (Buffer.byteLength(serializedResult, 'utf8') > (registered.descriptor.maxResultBytes ?? DEFAULT_RESULT_BYTES)) {
        throw new Error('The tool result exceeds its allowed size.')
      }
      return { toolId: request.toolId, startedAt, completedAt: new Date().toISOString(), result: checked, authorization: authorizationDecision }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}
