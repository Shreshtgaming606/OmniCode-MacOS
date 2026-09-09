import type { AIProviderId } from './contracts'

export type CloudAIProviderId = Exclude<AIProviderId, 'ollama'>

export type AIModelCapability =
  | 'chat'
  | 'streaming'
  | 'tool-calling'
  | 'vision'
  | 'large-context'
  | 'structured-output'
  | 'coding'

export type AIModelCapabilitySupport = 'supported' | 'unsupported' | 'unknown'

export type AIModelCapabilityEvidence =
  | 'provider-api'
  | 'ollama-show'
  | 'maintained-metadata'
  | 'verified'
  | 'unknown'

export interface AIModelCapabilityStatus {
  support: AIModelCapabilitySupport
  evidence: AIModelCapabilityEvidence
  note?: string
}

export type AIModelCapabilities = Record<AIModelCapability, AIModelCapabilityStatus>

export type AIModelUseCase =
  | 'code-chat'
  | 'code-agent'
  | 'code-autocomplete'
  | 'code-inline-edit'
  | 'work-chat'
  | 'work-tools'

export type AIModelUseCaseSupport =
  | 'compatible'
  | 'experimental'
  | 'chat-only'
  | 'incompatible'
  | 'unknown'

export interface AIModelUseCaseAssessment {
  useCase: AIModelUseCase
  support: AIModelUseCaseSupport
  reasons: string[]
}

export type AIModelAvailability = 'available' | 'unavailable' | 'unknown'
export type AIModelMetadataSource =
  | 'provider-api'
  | 'maintained-metadata'
  | 'ollama-show'
  | 'installed'
  | 'curated'

/**
 * Provider-neutral metadata for a selectable model. Capability entries are
 * deliberately evidence-bearing: absence of metadata is `unknown`, never an
 * implicit claim that a model can or cannot perform an action.
 */
export interface AIModelDescriptor {
  id: string
  provider: AIProviderId
  displayName: string
  description?: string
  local: boolean
  availability: AIModelAvailability
  contextWindow?: number
  maxOutputTokens?: number
  ownedBy?: string
  createdAt?: string
  capabilities: AIModelCapabilities
  metadataSource: AIModelMetadataSource
}

export type AIModelCatalogSource = 'provider-api' | 'cache' | 'maintained-fallback'

export type AIModelProviderState =
  | 'connected'
  | 'configured'
  | 'not-configured'
  | 'authentication-failed'
  | 'unavailable'

export interface AIModelCatalogResult {
  provider: CloudAIProviderId
  models: AIModelDescriptor[]
  source: AIModelCatalogSource
  providerState: AIModelProviderState
  stale: boolean
  truncated: boolean
  fetchedAt?: number
  checkedAt: number
  message: string
}

export interface AIModelCatalogQuery {
  forceRefresh?: boolean
}

export function unknownModelCapabilities(): AIModelCapabilities {
  return {
    chat: { support: 'unknown', evidence: 'unknown' },
    streaming: { support: 'unknown', evidence: 'unknown' },
    'tool-calling': { support: 'unknown', evidence: 'unknown' },
    vision: { support: 'unknown', evidence: 'unknown' },
    'large-context': { support: 'unknown', evidence: 'unknown' },
    'structured-output': { support: 'unknown', evidence: 'unknown' },
    coding: { support: 'unknown', evidence: 'unknown' }
  }
}

/**
 * Apply only the requirements OmniCode can prove from normalized metadata.
 * Work tool support is intentionally stricter than ordinary chat: a local or
 * maintained claim remains experimental until a real tool-call test verifies
 * it, while unknown tool support remains chat-only.
 */
export function assessModelForUseCase(
  model: AIModelDescriptor,
  useCase: AIModelUseCase
): AIModelUseCaseAssessment {
  if (model.availability === 'unavailable') {
    return { useCase, support: 'incompatible', reasons: ['The model is currently unavailable.'] }
  }
  const chat = model.capabilities.chat
  if (chat.support === 'unsupported') {
    return { useCase, support: 'incompatible', reasons: ['The model does not support chat generation.'] }
  }
  if (chat.support === 'unknown') {
    return { useCase, support: 'unknown', reasons: ['Chat compatibility has not been verified.'] }
  }
  if (useCase !== 'work-tools') return { useCase, support: 'compatible', reasons: [] }

  const tools = model.capabilities['tool-calling']
  if (tools.support === 'unsupported') {
    return { useCase, support: 'chat-only', reasons: ['The model does not support tool calling.'] }
  }
  if (tools.support === 'unknown') {
    return { useCase, support: 'chat-only', reasons: ['Tool-calling support is unknown.'] }
  }
  if (tools.evidence === 'verified' || tools.evidence === 'provider-api') {
    return { useCase, support: 'compatible', reasons: [] }
  }
  return {
    useCase,
    support: 'experimental',
    reasons: ['Tool calling is declared but has not completed OmniCode’s verification test.']
  }
}
