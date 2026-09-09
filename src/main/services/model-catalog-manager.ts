import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  AIModelCapabilities,
  AIModelCapability,
  AIModelCapabilityStatus,
  AIModelCatalogQuery,
  AIModelCatalogResult,
  AIModelDescriptor,
  AIModelProviderState,
  CloudAIProviderId
} from '../../shared/model-contracts'
import { unknownModelCapabilities } from '../../shared/model-contracts'

const CACHE_VERSION = 1
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PAGES = 10
const DEFAULT_MAX_MODELS = 1_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u
const LARGE_CONTEXT_THRESHOLD = 128_000

export interface ModelCatalogManagerOptions {
  getCredential(provider: CloudAIProviderId): Promise<string | undefined>
  fetch?: typeof fetch
  now?: () => number
  cachePath?: string
  cacheTtlMs?: number
  requestTimeoutMs?: number
  maxPages?: number
  maxModels?: number
  maxResponseBytes?: number
}

interface CachedProviderCatalog {
  fetchedAt: number
  truncated: boolean
  models: AIModelDescriptor[]
}

interface CacheDocument {
  version: typeof CACHE_VERSION
  providers: Partial<Record<CloudAIProviderId, CachedProviderCatalog>>
}

interface DiscoveryResult {
  models: AIModelDescriptor[]
  truncated: boolean
}

class ModelCatalogHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ModelCatalogHttpError'
  }
}

class ModelCatalogTimeoutError extends Error {
  constructor() {
    super('The provider did not respond before the model discovery timeout.')
    this.name = 'ModelCatalogTimeoutError'
  }
}

function supported(
  evidence: AIModelCapabilityStatus['evidence'],
  note?: string
): AIModelCapabilityStatus {
  return { support: 'supported', evidence, note }
}

function unsupported(
  evidence: AIModelCapabilityStatus['evidence'],
  note?: string
): AIModelCapabilityStatus {
  return { support: 'unsupported', evidence, note }
}

function capabilitiesWith(
  entries: Partial<Record<AIModelCapability, AIModelCapabilityStatus>>
): AIModelCapabilities {
  return { ...unknownModelCapabilities(), ...entries }
}

function fallbackModel(
  provider: CloudAIProviderId,
  id: string,
  displayName: string
): AIModelDescriptor {
  return {
    id,
    provider,
    displayName,
    local: false,
    availability: 'unknown',
    capabilities: capabilitiesWith({
      chat: supported(
        'maintained-metadata',
        'Maintained as a conservative text-generation fallback; account availability is unknown.'
      )
    }),
    metadataSource: 'maintained-metadata'
  }
}

/**
 * These small lists keep selectors useful before a credential is configured.
 * They are not availability claims: every entry is explicitly `unknown` until
 * it appears in the authenticated provider catalog.
 */
export const MAINTAINED_CLOUD_MODEL_FALLBACKS: Readonly<
  Record<CloudAIProviderId, readonly AIModelDescriptor[]>
> = {
  openai: [
    fallbackModel('openai', 'gpt-5', 'GPT-5'),
    fallbackModel('openai', 'gpt-5-mini', 'GPT-5 mini'),
    fallbackModel('openai', 'gpt-4.1', 'GPT-4.1'),
    fallbackModel('openai', 'gpt-4.1-mini', 'GPT-4.1 mini')
  ],
  anthropic: [
    fallbackModel('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5'),
    fallbackModel('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5')
  ],
  google: [
    fallbackModel('google', 'gemini-3.5-flash', 'Gemini 3.5 Flash'),
    fallbackModel('google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite')
  ]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function boundedString(value: unknown, maximum = 4_096): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized && normalized.length <= maximum ? normalized : undefined
}

function validModelId(value: unknown): string | undefined {
  const id = boundedString(value, 255)
  return id && MODEL_ID_PATTERN.test(id) ? id : undefined
}

function isoFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  try {
    return new Date(value * 1_000).toISOString()
  } catch {
    return undefined
  }
}

function cloneModel(model: AIModelDescriptor, cached = false): AIModelDescriptor {
  return {
    ...model,
    availability: cached ? 'unknown' : model.availability,
    capabilities: Object.fromEntries(
      Object.entries(model.capabilities).map(([key, value]) => [key, { ...value }])
    ) as AIModelCapabilities
  }
}

function dedupeAndSort(models: AIModelDescriptor[]): AIModelDescriptor[] {
  const unique = new Map<string, AIModelDescriptor>()
  for (const model of models) {
    const key = `${model.provider}:${model.id.toLowerCase()}`
    if (!unique.has(key)) unique.set(key, model)
  }
  return [...unique.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)
  )
}

function fallbackModels(provider: CloudAIProviderId): AIModelDescriptor[] {
  return MAINTAINED_CLOUD_MODEL_FALLBACKS[provider].map((model) => cloneModel(model))
}

function providerCapability(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  const object = record(value)
  return typeof object?.supported === 'boolean' ? object.supported : undefined
}

function setProviderCapability(
  capabilities: AIModelCapabilities,
  capability: AIModelCapability,
  value: unknown,
  note?: string
): void {
  const enabled = providerCapability(value)
  if (enabled === undefined) return
  capabilities[capability] = enabled
    ? supported('provider-api', note)
    : unsupported('provider-api', note)
}

function setLargeContextCapability(
  capabilities: AIModelCapabilities,
  contextWindow: number | undefined
): void {
  if (!contextWindow) return
  const note = `Compared with OmniCode's ${LARGE_CONTEXT_THRESHOLD.toLocaleString()}-token large-context threshold.`
  capabilities['large-context'] = contextWindow >= LARGE_CONTEXT_THRESHOLD
    ? supported('provider-api', note)
    : unsupported('provider-api', note)
}

function cachedModel(provider: CloudAIProviderId, value: unknown): AIModelDescriptor | undefined {
  const object = record(value)
  const id = validModelId(object?.id)
  const displayName = boundedString(object?.displayName, 512)
  if (!object || !id || !displayName || object.provider !== provider || object.local !== false) return undefined

  const capabilities = unknownModelCapabilities()
  const rawCapabilities = record(object.capabilities)
  for (const capability of Object.keys(capabilities) as AIModelCapability[]) {
    const raw = record(rawCapabilities?.[capability])
    if (!raw) continue
    const support = raw.support
    const evidence = raw.evidence
    if (
      !['supported', 'unsupported', 'unknown'].includes(String(support)) ||
      !['provider-api', 'maintained-metadata', 'unknown'].includes(String(evidence))
    ) continue
    capabilities[capability] = {
      support: support as AIModelCapabilityStatus['support'],
      evidence: evidence as AIModelCapabilityStatus['evidence'],
      note: boundedString(raw.note, 1_024)
    }
  }

  return {
    id,
    provider,
    displayName,
    description: boundedString(object.description),
    local: false,
    availability: 'unknown',
    contextWindow: finitePositiveInteger(object.contextWindow),
    maxOutputTokens: finitePositiveInteger(object.maxOutputTokens),
    ownedBy: boundedString(object.ownedBy, 512),
    createdAt: boundedString(object.createdAt, 128),
    capabilities,
    metadataSource: object.metadataSource === 'maintained-metadata'
      ? 'maintained-metadata'
      : 'provider-api'
  }
}

/**
 * OpenAI's model-list response contains IDs and ownership, not endpoint
 * capability metadata. Keep only conservative, known text-generation families
 * and explicitly reject specialized families that cannot use OmniCode's text
 * chat adapter.
 */
export function isCompatibleOpenAIModelId(candidate: string): boolean {
  const normalized = candidate.toLowerCase()
  const base = normalized.startsWith('ft:') ? normalized.split(':')[1] ?? '' : normalized
  if (!base || [
    'audio', 'realtime', 'transcribe', 'transcription', 'tts', 'image', 'dall-e',
    'sora', 'embedding', 'moderation', 'search', 'deep-research', 'computer-use',
    'codex', 'whisper', 'instruct'
  ].some((marker) => base.includes(marker))) return false

  return /^gpt-(?:(?:[3-9](?:\.\d+)?)|4o)(?:$|-)/u.test(base) ||
    /^o[134](?:$|-)/u.test(base)
}

/**
 * The Gemini catalog also contains speech, image-generation, live-session,
 * embedding, and experimental agent surfaces. OmniCode's current Google
 * transport expects text from generateContent, so keep selection conservative
 * until a dedicated multimodal transport exists.
 */
export function isCompatibleGoogleTextModelId(candidate: string): boolean {
  const normalized = candidate.toLowerCase()
  return normalized.startsWith('gemini-') && ![
    'embedding', 'image', 'imagen', 'tts', 'audio', 'live', 'robotics',
    'computer-use', 'deep-research', 'aqa'
  ].some((marker) => normalized.includes(marker))
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`The provider model response exceeded ${maximumBytes} bytes.`)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`The provider model response exceeded ${maximumBytes} bytes.`)
      }
      output += decoder.decode(value, { stream: true })
    }
    output += decoder.decode()
    return output
  } finally {
    reader.releaseLock()
  }
}

function conciseProviderDetail(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized
}

function errorProviderState(error: unknown): AIModelProviderState {
  return error instanceof ModelCatalogHttpError && (error.status === 401 || error.status === 403)
    ? 'authentication-failed'
    : 'unavailable'
}

export class ModelCatalogManager {
  readonly #getCredential: ModelCatalogManagerOptions['getCredential']
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #cachePath?: string
  readonly #cacheTtlMs: number
  readonly #requestTimeoutMs: number
  readonly #maxPages: number
  readonly #maxModels: number
  readonly #maxResponseBytes: number
  readonly #cache = new Map<CloudAIProviderId, CachedProviderCatalog>()
  readonly #refreshes = new Map<CloudAIProviderId, Promise<AIModelCatalogResult>>()
  #cacheLoad?: Promise<void>
  #cacheWrite: Promise<void> = Promise.resolve()

  constructor(options: ModelCatalogManagerOptions) {
    this.#getCredential = options.getCredential
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
    this.#cachePath = options.cachePath
    this.#cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)
    this.#requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    this.#maxPages = Math.max(1, Math.min(100, options.maxPages ?? DEFAULT_MAX_PAGES))
    this.#maxModels = Math.max(1, Math.min(10_000, options.maxModels ?? DEFAULT_MAX_MODELS))
    this.#maxResponseBytes = Math.max(1_024, Math.min(16 * 1024 * 1024, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES))
  }

  async listModels(
    provider: CloudAIProviderId,
    query: AIModelCatalogQuery = {}
  ): Promise<AIModelCatalogResult> {
    if (!['openai', 'anthropic', 'google'].includes(provider)) {
      throw new Error('Choose a supported cloud model provider.')
    }
    await this.#loadCache()
    const checkedAt = this.#now()
    let credential: string | undefined
    try {
      credential = (await this.#getCredential(provider))?.trim()
    } catch (error) {
      return this.#unavailableResult(provider, error, checkedAt)
    }

    if (!credential) {
      return {
        provider,
        models: fallbackModels(provider),
        source: 'maintained-fallback',
        providerState: 'not-configured',
        stale: false,
        truncated: false,
        checkedAt,
        message: 'Configure this provider to retrieve the models available to your account.'
      }
    }

    const cached = this.#cache.get(provider)
    if (
      !query.forceRefresh && cached && checkedAt >= cached.fetchedAt &&
      checkedAt - cached.fetchedAt <= this.#cacheTtlMs
    ) {
      return this.#cacheResult(provider, cached, false, 'configured', checkedAt,
        'Using the recently refreshed model catalog.')
    }

    const active = this.#refreshes.get(provider)
    if (active) return active
    const refresh = this.#refresh(provider, credential, checkedAt)
    this.#refreshes.set(provider, refresh)
    try {
      return await refresh
    } finally {
      if (this.#refreshes.get(provider) === refresh) this.#refreshes.delete(provider)
    }
  }

  async #refresh(
    provider: CloudAIProviderId,
    credential: string,
    checkedAt: number
  ): Promise<AIModelCatalogResult> {
    try {
      const discovered = provider === 'openai'
        ? await this.#discoverOpenAI(credential)
        : provider === 'anthropic'
          ? await this.#discoverAnthropic(credential)
          : await this.#discoverGoogle(credential)
      const models = dedupeAndSort(discovered.models).slice(0, this.#maxModels)
      const catalog: CachedProviderCatalog = {
        fetchedAt: checkedAt,
        truncated: discovered.truncated || models.length < discovered.models.length,
        models: models.map((model) => cloneModel(model))
      }
      this.#cache.set(provider, catalog)
      await this.#persistCache()
      return {
        provider,
        models: models.map((model) => cloneModel(model)),
        source: 'provider-api',
        providerState: 'connected',
        stale: false,
        truncated: catalog.truncated,
        fetchedAt: checkedAt,
        checkedAt,
        message: catalog.truncated
          ? 'Models refreshed from the provider; the bounded catalog was truncated.'
          : 'Models refreshed from the provider.'
      }
    } catch (error) {
      return this.#unavailableResult(provider, error, checkedAt, credential)
    }
  }

  #unavailableResult(
    provider: CloudAIProviderId,
    error: unknown,
    checkedAt: number,
    credential?: string
  ): AIModelCatalogResult {
    const providerState = errorProviderState(error)
    const rawMessage = error instanceof Error ? error.message : String(error)
    const safeMessage = credential ? rawMessage.replaceAll(credential, '••••') : rawMessage
    const cached = this.#cache.get(provider)
    if (cached) {
      return this.#cacheResult(
        provider,
        cached,
        true,
        providerState,
        checkedAt,
        `Model refresh failed; showing the last successful catalog. ${safeMessage}`
      )
    }
    return {
      provider,
      models: fallbackModels(provider),
      source: 'maintained-fallback',
      providerState,
      stale: true,
      truncated: false,
      checkedAt,
      message: `Live model discovery is unavailable; showing a conservative fallback list. ${safeMessage}`
    }
  }

  #cacheResult(
    provider: CloudAIProviderId,
    cached: CachedProviderCatalog,
    stale: boolean,
    providerState: AIModelProviderState,
    checkedAt: number,
    message: string
  ): AIModelCatalogResult {
    return {
      provider,
      models: cached.models.map((model) => cloneModel(model, true)),
      source: 'cache',
      providerState,
      stale,
      truncated: cached.truncated,
      fetchedAt: cached.fetchedAt,
      checkedAt,
      message
    }
  }

  async #request(
    provider: CloudAIProviderId,
    url: string,
    headers: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs)
    let response: Response
    try {
      response = await this.#fetch(url, { method: 'GET', headers, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new ModelCatalogTimeoutError()
      throw error
    } finally {
      clearTimeout(timeout)
    }

    const body = await boundedResponseText(response, this.#maxResponseBytes)
    if (!response.ok) {
      const detail = conciseProviderDetail(body)
      throw new ModelCatalogHttpError(
        response.status,
        `${provider} model discovery returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
      )
    }
    try {
      const parsed = JSON.parse(body) as unknown
      const object = record(parsed)
      if (!object) throw new Error('The response was not a JSON object.')
      return object
    } catch (error) {
      throw new Error(`The provider returned an invalid model catalog: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async #discoverOpenAI(credential: string): Promise<DiscoveryResult> {
    const response = await this.#request('openai', 'https://api.openai.com/v1/models', {
      Authorization: `Bearer ${credential}`
    })
    const data = Array.isArray(response.data) ? response.data : []
    const truncated = data.length > this.#maxModels
    const models = data.slice(0, this.#maxModels).flatMap((entry): AIModelDescriptor[] => {
      const object = record(entry)
      const id = validModelId(object?.id)
      if (!object || !id || !isCompatibleOpenAIModelId(id)) return []
      return [{
        id,
        provider: 'openai',
        displayName: id,
        local: false,
        availability: 'unknown',
        ownedBy: boundedString(object.owned_by, 512),
        createdAt: isoFromUnixSeconds(object.created),
        capabilities: capabilitiesWith({
          chat: supported(
            'maintained-metadata',
            'Included by OmniCode’s conservative text-generation family filter; the Models API does not expose endpoint capabilities.'
          )
        }),
        metadataSource: 'provider-api'
      }]
    })
    return { models, truncated }
  }

  async #discoverAnthropic(credential: string): Promise<DiscoveryResult> {
    const models: AIModelDescriptor[] = []
    let afterId: string | undefined
    let truncated = false

    for (let page = 0; page < this.#maxPages; page++) {
      const remaining = this.#maxModels - models.length
      if (remaining <= 0) {
        truncated = true
        break
      }
      const url = new URL('https://api.anthropic.com/v1/models')
      url.searchParams.set('limit', String(Math.min(100, remaining)))
      if (afterId) url.searchParams.set('after_id', afterId)
      const response = await this.#request('anthropic', url.toString(), {
        'x-api-key': credential,
        'anthropic-version': '2023-06-01'
      })
      const data = Array.isArray(response.data) ? response.data : []
      for (const entry of data) {
        if (models.length >= this.#maxModels) {
          truncated = true
          break
        }
        const object = record(entry)
        const id = validModelId(object?.id)
        if (!object || !id || !id.toLowerCase().startsWith('claude-')) continue
        const contextWindow = finitePositiveInteger(object.max_input_tokens)
        const capabilities = capabilitiesWith({
          chat: supported('maintained-metadata', 'Claude Models API entries are used with the Messages API.')
        })
        const providerCapabilities = record(object.capabilities)
        setProviderCapability(capabilities, 'tool-calling', providerCapabilities?.tool_use ?? providerCapabilities?.tool_calling)
        setProviderCapability(capabilities, 'vision', providerCapabilities?.image_input)
        setProviderCapability(capabilities, 'structured-output', providerCapabilities?.structured_outputs)
        setProviderCapability(capabilities, 'streaming', providerCapabilities?.streaming)
        setLargeContextCapability(capabilities, contextWindow)
        models.push({
          id,
          provider: 'anthropic',
          displayName: boundedString(object.display_name, 512) ?? id,
          local: false,
          availability: 'unknown',
          contextWindow,
          maxOutputTokens: finitePositiveInteger(object.max_tokens),
          createdAt: boundedString(object.created_at, 128),
          capabilities,
          metadataSource: 'provider-api'
        })
      }

      const hasMore = response.has_more === true
      if (!hasMore) break
      const next = boundedString(response.last_id, 512)
      if (!next || next === afterId || page + 1 >= this.#maxPages || models.length >= this.#maxModels) {
        truncated = true
        break
      }
      afterId = next
    }
    return { models, truncated }
  }

  async #discoverGoogle(credential: string): Promise<DiscoveryResult> {
    const models: AIModelDescriptor[] = []
    let pageToken: string | undefined
    let truncated = false

    for (let page = 0; page < this.#maxPages; page++) {
      const remaining = this.#maxModels - models.length
      if (remaining <= 0) {
        truncated = true
        break
      }
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
      url.searchParams.set('pageSize', String(Math.min(100, remaining)))
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const response = await this.#request('google', url.toString(), {
        'x-goog-api-key': credential
      })
      const data = Array.isArray(response.models) ? response.models : []
      for (const entry of data) {
        if (models.length >= this.#maxModels) {
          truncated = true
          break
        }
        const object = record(entry)
        const methods = Array.isArray(object?.supportedGenerationMethods)
          ? object.supportedGenerationMethods.filter((value): value is string => typeof value === 'string')
          : []
        const normalizedMethods = new Set(methods.map((method) => method.toLowerCase()))
        if (!normalizedMethods.has('generatecontent')) continue
        const resourceName = boundedString(object?.name, 512)
        const id = validModelId(resourceName?.replace(/^models\//u, '') ?? object?.baseModelId)
        if (!object || !id || !isCompatibleGoogleTextModelId(id)) continue
        const contextWindow = finitePositiveInteger(object.inputTokenLimit)
        const capabilities = capabilitiesWith({
          chat: supported('provider-api', 'The provider advertises generateContent for this model.'),
          streaming: normalizedMethods.has('streamgeneratecontent')
            ? supported('provider-api', 'The provider advertises streamGenerateContent for this model.')
            : { support: 'unknown', evidence: 'unknown' }
        })
        setLargeContextCapability(capabilities, contextWindow)
        models.push({
          id,
          provider: 'google',
          displayName: boundedString(object.displayName, 512) ?? id,
          description: boundedString(object.description),
          local: false,
          availability: 'unknown',
          contextWindow,
          maxOutputTokens: finitePositiveInteger(object.outputTokenLimit),
          capabilities,
          metadataSource: 'provider-api'
        })
      }

      const next = boundedString(response.nextPageToken, 2_048)
      if (!next) break
      if (next === pageToken || page + 1 >= this.#maxPages || models.length >= this.#maxModels) {
        truncated = true
        break
      }
      pageToken = next
    }
    return { models, truncated }
  }

  #loadCache(): Promise<void> {
    if (this.#cacheLoad) return this.#cacheLoad
    this.#cacheLoad = (async () => {
      if (!this.#cachePath) return
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(this.#cachePath, 'utf8')) as unknown
      } catch {
        return
      }
      const document = record(parsed)
      const providers = record(document?.providers)
      if (document?.version !== CACHE_VERSION || !providers) return
      for (const provider of ['openai', 'anthropic', 'google'] as const) {
        const entry = record(providers[provider])
        const fetchedAt = typeof entry?.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt)
          ? entry.fetchedAt
          : undefined
        if (fetchedAt === undefined || !Array.isArray(entry?.models)) continue
        const models = entry.models
          .slice(0, this.#maxModels)
          .map((model) => cachedModel(provider, model))
          .filter((model): model is AIModelDescriptor => Boolean(model))
        if (!models.length) continue
        this.#cache.set(provider, {
          fetchedAt,
          truncated: entry.truncated === true || entry.models.length > this.#maxModels,
          models: dedupeAndSort(models)
        })
      }
    })()
    return this.#cacheLoad
  }

  #persistCache(): Promise<void> {
    if (!this.#cachePath) return Promise.resolve()
    const cachePath = this.#cachePath
    this.#cacheWrite = this.#cacheWrite.catch(() => undefined).then(async () => {
      const providers: CacheDocument['providers'] = {}
      for (const [provider, catalog] of this.#cache) {
        providers[provider] = {
          fetchedAt: catalog.fetchedAt,
          truncated: catalog.truncated,
          models: catalog.models.map((model) => cloneModel(model))
        }
      }
      const document: CacheDocument = { version: CACHE_VERSION, providers }
      await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 })
      const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600
        })
        await rename(temporaryPath, cachePath)
        await chmod(cachePath, 0o600)
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined)
        throw error
      }
    })
    return this.#cacheWrite
  }
}
