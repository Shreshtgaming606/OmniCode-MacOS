import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AIProviderId, ProviderDataPolicy } from '../../shared/contracts'

const LAST_REVIEWED = '2026-09-23'
const POLICY_REVISION = 'google-workspace-cloud-transfer-v2'
const GEMINI_VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000

const GOOGLE_WORKSPACE_POLICY_URL = 'https://developers.google.com/workspace/workspace-api-user-data-developer-policy'
const OLLAMA_PRIVACY_URL = 'https://ollama.com/privacy'
const OPENAI_DATA_URL = 'https://developers.openai.com/api/docs/guides/your-data'
const ANTHROPIC_TRAINING_URL = 'https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training'
const ANTHROPIC_RETENTION_URL = 'https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data'
const GEMINI_TERMS_URL = 'https://ai.google.dev/gemini-api/terms'
const GEMINI_BILLING_URL = 'https://ai.google.dev/gemini-api/docs/billing'
const GEMINI_ZDR_URL = 'https://ai.google.dev/gemini-api/docs/zdr'

type CloudProvider = Exclude<AIProviderId, 'ollama'>

interface StoredGeminiVerification {
  plan: 'paid' | 'free'
  credentialFingerprint: string
  verifiedAt: string
  expiresAt?: string
  method: 'manual-ai-studio-paid-plan' | 'manual-ai-studio-free-plan'
}

interface StoredCloudConsent {
  credentialFingerprint: string
  grantedAt: string
  policyRevision: typeof POLICY_REVISION
}

interface ProviderPolicyStore {
  version: 1
  gemini?: StoredGeminiVerification
  consents: Partial<Record<CloudProvider, StoredCloudConsent>>
}

export interface ProviderPolicyManagerOptions {
  settingsPath?: string
  getCredential?(provider: CloudProvider): Promise<string | undefined>
  testProviderConnection?(provider: CloudProvider): Promise<{ state: string }>
  now?: () => number
}

export interface ConfigureGeminiWorkspaceRequest {
  plan: 'paid' | 'free'
  confirmedAiStudioPlan?: boolean
  confirmedMatchingCredential?: boolean
}

function emptyStore(): ProviderPolicyStore {
  return { version: 1, consents: {} }
}

function isCloudProvider(value: AIProviderId): value is CloudProvider {
  return value === 'openai' || value === 'anthropic' || value === 'google'
}

function ollamaCloudModel(model: string | undefined): boolean {
  const value = model?.trim().toLowerCase() ?? ''
  return /(?:^|[:/_-])cloud(?:$|[:/_-])/u.test(value)
}

function credentialFingerprint(value: string): string {
  return createHash('sha256').update(`omnicode-provider-policy\0${value}`, 'utf8').digest('hex')
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseStore(value: unknown): ProviderPolicyStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyStore()
  const candidate = value as Partial<ProviderPolicyStore>
  if (candidate.version !== 1 || !candidate.consents || typeof candidate.consents !== 'object' || Array.isArray(candidate.consents)) return emptyStore()
  const result = emptyStore()
  const gemini = candidate.gemini
  if (gemini && (gemini.plan === 'paid' || gemini.plan === 'free') &&
      typeof gemini.credentialFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(gemini.credentialFingerprint) &&
      validIsoTimestamp(gemini.verifiedAt) &&
      (gemini.expiresAt === undefined || validIsoTimestamp(gemini.expiresAt)) &&
      gemini.method === (gemini.plan === 'paid' ? 'manual-ai-studio-paid-plan' : 'manual-ai-studio-free-plan')) {
    result.gemini = { ...gemini }
  }
  for (const provider of ['openai', 'anthropic', 'google'] as const) {
    const consent = candidate.consents[provider]
    if (consent && typeof consent.credentialFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(consent.credentialFingerprint) &&
        validIsoTimestamp(consent.grantedAt) && consent.policyRevision === POLICY_REVISION) {
      result.consents[provider] = { ...consent }
    }
  }
  return result
}

/**
 * Main-process boundary for sending Google Workspace content to an AI provider.
 *
 * A Gemini key cannot reveal its Paid/Free plan through the Gemini API. The
 * explicit AI Studio confirmation is therefore bound to a one-way credential
 * fingerprint, expires after seven days, and is invalidated by key rotation.
 * No raw credential is written to this store or returned to the renderer.
 */
export class ProviderPolicyManager {
  readonly #settingsPath?: string
  readonly #getCredential?: ProviderPolicyManagerOptions['getCredential']
  readonly #testProviderConnection?: ProviderPolicyManagerOptions['testProviderConnection']
  readonly #now: () => number
  #store?: ProviderPolicyStore
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(options: ProviderPolicyManagerOptions = {}) {
    this.#settingsPath = options.settingsPath
    this.#getCredential = options.getCredential
    this.#testProviderConnection = options.testProviderConnection
    this.#now = options.now ?? (() => Date.now())
  }

  async #readStore(): Promise<ProviderPolicyStore> {
    if (this.#store) return this.#store
    if (!this.#settingsPath) return (this.#store = emptyStore())
    try {
      const text = await readFile(this.#settingsPath, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) return (this.#store = emptyStore())
      return (this.#store = parseStore(JSON.parse(text) as unknown))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      return (this.#store = emptyStore())
    }
  }

  async #writeStore(store: ProviderPolicyStore): Promise<void> {
    this.#store = store
    if (!this.#settingsPath) return
    const settingsPath = this.#settingsPath
    const payload = `${JSON.stringify(store, null, 2)}\n`
    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir(dirname(settingsPath), { recursive: true })
      const temporaryPath = `${settingsPath}.${process.pid}.tmp`
      await writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, settingsPath)
    })
    await this.#writeQueue
  }

  async #fingerprint(provider: CloudProvider): Promise<string | undefined> {
    const value = await this.#getCredential?.(provider)
    return typeof value === 'string' && value.trim() ? credentialFingerprint(value.trim()) : undefined
  }

  async #consentGranted(provider: CloudProvider, fingerprint: string | undefined): Promise<boolean> {
    if (!fingerprint) return false
    const stored = (await this.#readStore()).consents[provider]
    return stored?.credentialFingerprint === fingerprint && stored.policyRevision === POLICY_REVISION
  }

  async policyFor(provider: AIProviderId, model?: string): Promise<ProviderDataPolicy> {
    if (provider === 'ollama') {
      const cloudModel = ollamaCloudModel(model)
      return {
        provider,
        ...(model ? { model } : {}),
        displayName: cloudModel ? 'Ollama cloud model' : 'Ollama local model',
        verificationState: cloudModel ? 'UNVERIFIED' : 'VERIFIED_ELIGIBLE',
        verificationMethod: cloudModel ? 'none' : 'local-runtime',
        workspaceDataEligible: !cloudModel,
        allowsGoogleWorkspaceData: !cloudModel,
        consentRequired: false,
        consentGranted: true,
        plan: cloudModel ? 'unknown' : 'local',
        zeroDataRetention: cloudModel ? 'unknown' : 'not-applicable',
        cloud: cloudModel,
        endpointType: cloudModel
          ? 'Local Ollama API routing to an Ollama-hosted cloud model'
          : 'Loopback Ollama API at 127.0.0.1',
        retention: cloudModel
          ? 'Blocked for Google Workspace use because OmniCode does not independently verify the hosted model configuration.'
          : 'OmniCode does not create provider-side prompt storage for local inference.',
        training: cloudModel
          ? 'Not relied on by OmniCode for Google Workspace use.'
          : 'Local prompts are not sent to Ollama by OmniCode for model training.',
        dataRegion: cloudModel ? 'Not selected by OmniCode.' : 'On this Mac.',
        rationale: cloudModel
          ? 'Google Workspace content is blocked because an Ollama cloud model is not local inference.'
          : 'Allowed only for a locally served model; Google API traffic still communicates with Google.',
        lastReviewed: LAST_REVIEWED,
        documentationUrls: [OLLAMA_PRIVACY_URL, GOOGLE_WORKSPACE_POLICY_URL]
      }
    }

    const fingerprint = await this.#fingerprint(provider)
    const consentGranted = await this.#consentGranted(provider, fingerprint)
    if (provider === 'openai') {
      return {
        provider,
        ...(model ? { model } : {}),
        displayName: 'OpenAI API',
        verificationState: 'VERIFIED_ELIGIBLE',
        verificationMethod: 'documented-api-terms',
        workspaceDataEligible: true,
        allowsGoogleWorkspaceData: consentGranted,
        consentRequired: true,
        consentGranted,
        plan: 'paid',
        zeroDataRetention: 'not-configured',
        cloud: true,
        endpointType: 'OpenAI API Chat Completions endpoint',
        retention: 'OpenAI documents abuse-monitoring logs retained for up to 30 days by default; eligible customers may have different controls.',
        training: 'OpenAI states API inputs and outputs are not used to train models by default unless the customer opts in.',
        dataRegion: 'Not selected by OmniCode; provider account and product configuration apply.',
        rationale: consentGranted
          ? 'Eligible for minimum-context Google Workspace use under documented API defaults, with the user’s connected-data consent.'
          : 'The provider is eligible, but Google Workspace transfer remains disabled until the user grants connected-data consent.',
        lastReviewed: LAST_REVIEWED,
        documentationUrls: [OPENAI_DATA_URL, GOOGLE_WORKSPACE_POLICY_URL]
      }
    }
    if (provider === 'anthropic') {
      return {
        provider,
        ...(model ? { model } : {}),
        displayName: 'Anthropic API',
        verificationState: 'VERIFIED_ELIGIBLE',
        verificationMethod: 'documented-api-terms',
        workspaceDataEligible: true,
        allowsGoogleWorkspaceData: consentGranted,
        consentRequired: true,
        consentGranted,
        plan: 'paid',
        zeroDataRetention: 'not-configured',
        cloud: true,
        endpointType: 'Anthropic commercial API Messages endpoint',
        retention: 'Anthropic documents automatic deletion of API inputs and outputs within 30 days by default, subject to stated safety, legal, and agreement exceptions.',
        training: 'Anthropic states commercial/API inputs and outputs are not used to train generative models by default unless the customer opts in or provides feedback.',
        dataRegion: 'Not selected by OmniCode; provider account and product configuration apply.',
        rationale: consentGranted
          ? 'Eligible for minimum-context Google Workspace use under documented commercial API defaults, with the user’s connected-data consent.'
          : 'The provider is eligible, but Google Workspace transfer remains disabled until the user grants connected-data consent.',
        lastReviewed: LAST_REVIEWED,
        documentationUrls: [ANTHROPIC_TRAINING_URL, ANTHROPIC_RETENTION_URL, GOOGLE_WORKSPACE_POLICY_URL]
      }
    }

    const stored = (await this.#readStore()).gemini
    const credentialMatches = Boolean(fingerprint && stored?.credentialFingerprint === fingerprint)
    const expired = Boolean(stored?.expiresAt && Date.parse(stored.expiresAt) <= this.#now())
    const paidEligible = stored?.plan === 'paid' && credentialMatches && !expired
    const freeIneligible = stored?.plan === 'free' && credentialMatches
    const verificationState = paidEligible
      ? 'VERIFIED_ELIGIBLE' as const
      : freeIneligible
        ? 'INELIGIBLE' as const
        : stored?.plan === 'paid' && credentialMatches && expired
          ? 'UNVERIFIED' as const
          : 'UNKNOWN' as const
    const workspaceDataEligible = verificationState === 'VERIFIED_ELIGIBLE'
    const allowsGoogleWorkspaceData = workspaceDataEligible && consentGranted
    return {
      provider,
      ...(model ? { model } : {}),
      displayName: 'Google Gemini Developer API',
      verificationState,
      verificationMethod: paidEligible
        ? 'manual-ai-studio-paid-plan'
        : freeIneligible
          ? 'manual-ai-studio-free-plan'
          : 'none',
      workspaceDataEligible,
      allowsGoogleWorkspaceData,
      consentRequired: true,
      consentGranted,
      plan: paidEligible ? 'paid' : freeIneligible ? 'free' : 'unknown',
      zeroDataRetention: paidEligible ? 'not-configured' : 'unknown',
      ...(paidEligible && stored ? { verifiedAt: stored.verifiedAt, verificationExpiresAt: stored.expiresAt } : {}),
      cloud: true,
      endpointType: 'Gemini Developer API generateContent endpoint',
      retention: paidEligible
        ? 'Paid Gemini Developer API requests may be retained for a limited period for abuse monitoring. OmniCode does not claim zero data retention.'
        : 'Paid and unpaid Gemini Developer API services have different data handling. OmniCode cannot determine the billing tier from an API key.',
      training: paidEligible
        ? 'Google states Paid Services prompts and responses are not used to improve Google products.'
        : 'Google states Unpaid Services content may be used to improve products; Google Workspace data remains blocked.',
      dataRegion: 'Not selected or verified by OmniCode.',
      rationale: allowsGoogleWorkspaceData
        ? 'The saved credential passed a connection test, the user confirmed its matching AI Studio project shows Paid, and connected-data consent is active.'
        : workspaceDataEligible
          ? 'This configuration is eligible, but Google Workspace transfer remains disabled until the user grants connected-data consent.'
          : freeIneligible
            ? 'This configuration is recorded as Free/Unpaid and cannot receive Google Workspace content.'
            : expired
              ? 'The manual AI Studio paid-plan verification expired and must be refreshed.'
              : 'Blocked because OmniCode cannot infer Paid Services eligibility from a Gemini API key. Verify the matching project in Google AI Studio.',
      lastReviewed: LAST_REVIEWED,
      documentationUrls: [GEMINI_TERMS_URL, GEMINI_BILLING_URL, GEMINI_ZDR_URL, GOOGLE_WORKSPACE_POLICY_URL]
    }
  }

  async configureGeminiWorkspace(request: ConfigureGeminiWorkspaceRequest): Promise<ProviderDataPolicy> {
    if (!request || (request.plan !== 'paid' && request.plan !== 'free')) throw new Error('Choose Paid or Free for the Gemini Workspace configuration.')
    const fingerprint = await this.#fingerprint('google')
    if (!fingerprint) throw new Error('Save a Gemini API credential before configuring Workspace data compatibility.')
    if (request.plan === 'paid') {
      if (request.confirmedAiStudioPlan !== true || request.confirmedMatchingCredential !== true) {
        throw new Error('Confirm both the Paid plan and that it belongs to the project used by the saved Gemini credential.')
      }
      const connection = await this.#testProviderConnection?.('google')
      if (!connection || connection.state !== 'connected') {
        throw new Error('The saved Gemini credential must pass Test Connection before paid-plan verification can be recorded.')
      }
    }
    const now = this.#now()
    const store = await this.#readStore()
    store.gemini = {
      plan: request.plan,
      credentialFingerprint: fingerprint,
      verifiedAt: new Date(now).toISOString(),
      ...(request.plan === 'paid' ? { expiresAt: new Date(now + GEMINI_VERIFICATION_TTL_MS).toISOString() } : {}),
      method: request.plan === 'paid' ? 'manual-ai-studio-paid-plan' : 'manual-ai-studio-free-plan'
    }
    delete store.consents.google
    await this.#writeStore(store)
    return this.policyFor('google')
  }

  async clearGeminiWorkspaceVerification(): Promise<ProviderDataPolicy> {
    const store = await this.#readStore()
    delete store.gemini
    delete store.consents.google
    await this.#writeStore(store)
    return this.policyFor('google')
  }

  async setGoogleWorkspaceConsent(provider: AIProviderId, granted: boolean): Promise<ProviderDataPolicy> {
    if (!isCloudProvider(provider)) {
      if (provider === 'ollama') return this.policyFor(provider)
      throw new Error('Choose a supported cloud provider for connected-data consent.')
    }
    if (typeof granted !== 'boolean') throw new Error('Connected-data consent must be enabled or disabled.')
    const policy = await this.policyFor(provider)
    if (granted && !policy.workspaceDataEligible) {
      throw new Error(`${policy.displayName} is not eligible to receive Google Workspace data in this configuration.`)
    }
    const store = await this.#readStore()
    if (!granted) {
      delete store.consents[provider]
    } else {
      const fingerprint = await this.#fingerprint(provider)
      if (!fingerprint) throw new Error(`Save a ${policy.displayName} credential before granting connected-data consent.`)
      store.consents[provider] = {
        credentialFingerprint: fingerprint,
        grantedAt: new Date(this.#now()).toISOString(),
        policyRevision: POLICY_REVISION
      }
    }
    await this.#writeStore(store)
    return this.policyFor(provider)
  }

  async assertGoogleWorkspaceTransferAllowed(provider: AIProviderId, model?: string): Promise<ProviderDataPolicy> {
    const policy = await this.policyFor(provider, model)
    if (!policy.workspaceDataEligible) {
      throw new Error(`${policy.displayName} cannot process Google Workspace data in this configuration. The service may still be connected; verify an eligible provider configuration.`)
    }
    if (!policy.allowsGoogleWorkspaceData) {
      throw new Error(`${policy.displayName} is eligible, but Google Workspace transfer consent has not been granted.`)
    }
    return policy
  }
}

export function isGoogleWorkspaceConnector(connectorId: string | undefined): boolean {
  return connectorId === 'gmail' || connectorId === 'google-drive'
}
