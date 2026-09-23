import type { AIProviderId, ProviderDataPolicy } from '../../shared/contracts'

const LAST_REVIEWED = '2026-09-23'

const GOOGLE_WORKSPACE_POLICY_URL = 'https://developers.google.com/workspace/workspace-api-user-data-developer-policy'
const OLLAMA_PRIVACY_URL = 'https://ollama.com/privacy'
const OPENAI_DATA_URL = 'https://developers.openai.com/api/docs/guides/your-data'
const ANTHROPIC_TRAINING_URL = 'https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training'
const ANTHROPIC_RETENTION_URL = 'https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data'
const GEMINI_BILLING_URL = 'https://ai.google.dev/gemini-api/docs/billing'
const GEMINI_ZDR_URL = 'https://ai.google.dev/gemini-api/docs/zdr'

function ollamaCloudModel(model: string | undefined): boolean {
  const value = model?.trim().toLowerCase() ?? ''
  return /(?:^|[:/_-])cloud(?:$|[:/_-])/u.test(value)
}

/**
 * Main-process policy boundary for sending Google Workspace content to an AI
 * provider. Policy text is deliberately conservative: a configuration is
 * allowed only when the endpoint used by OmniCode has documented no-training
 * terms or is verified to remain on the user's Mac.
 */
export class ProviderPolicyManager {
  policyFor(provider: AIProviderId, model?: string): ProviderDataPolicy {
    if (provider === 'ollama') {
      const cloudModel = ollamaCloudModel(model)
      return {
        provider,
        ...(model ? { model } : {}),
        displayName: cloudModel ? 'Ollama cloud model' : 'Ollama local model',
        allowsGoogleWorkspaceData: !cloudModel,
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
    if (provider === 'openai') {
      return {
        provider,
        ...(model ? { model } : {}),
        displayName: 'OpenAI API',
        allowsGoogleWorkspaceData: true,
        cloud: true,
        endpointType: 'OpenAI API Chat Completions endpoint',
        retention: 'OpenAI documents abuse-monitoring logs retained for up to 30 days by default; eligible customers may have different controls.',
        training: 'OpenAI states API inputs and outputs are not used to train models by default unless the customer opts in.',
        dataRegion: 'Not selected by OmniCode; provider account and product configuration apply.',
        rationale: 'Allowed for the minimum Google Workspace context required by a user-requested feature. OmniCode sets store=false and does not submit feedback or opt in to training.',
        lastReviewed: LAST_REVIEWED,
        documentationUrls: [OPENAI_DATA_URL, GOOGLE_WORKSPACE_POLICY_URL]
      }
    }
    if (provider === 'anthropic') {
      return {
        provider,
        ...(model ? { model } : {}),
        displayName: 'Anthropic API',
        allowsGoogleWorkspaceData: true,
        cloud: true,
        endpointType: 'Anthropic commercial API Messages endpoint',
        retention: 'Anthropic documents automatic deletion of API inputs and outputs within 30 days by default, subject to stated safety, legal, and agreement exceptions.',
        training: 'Anthropic states commercial/API inputs and outputs are not used to train generative models by default unless the customer opts in or provides feedback.',
        dataRegion: 'Not selected by OmniCode; provider account and product configuration apply.',
        rationale: 'Allowed for the minimum Google Workspace context required by a user-requested feature under the documented commercial API defaults.',
        lastReviewed: LAST_REVIEWED,
        documentationUrls: [ANTHROPIC_TRAINING_URL, ANTHROPIC_RETENTION_URL, GOOGLE_WORKSPACE_POLICY_URL]
      }
    }
    return {
      provider,
      ...(model ? { model } : {}),
      displayName: 'Google Gemini Developer API',
      allowsGoogleWorkspaceData: false,
      cloud: true,
      endpointType: 'Gemini Developer API generateContent endpoint',
      retention: 'Paid and unpaid Gemini Developer API services have different data-handling terms; OmniCode cannot determine the billing tier from an API key.',
      training: 'Google documents that unpaid-service content may be used to improve products, while paid-service content is not used for product improvement.',
      dataRegion: 'Not selected or verified by OmniCode.',
      rationale: 'Blocked because OmniCode cannot verify that the configured API key uses an eligible paid service with compatible data handling.',
      lastReviewed: LAST_REVIEWED,
      documentationUrls: [GEMINI_BILLING_URL, GEMINI_ZDR_URL, GOOGLE_WORKSPACE_POLICY_URL]
    }
  }

  assertGoogleWorkspaceTransferAllowed(provider: AIProviderId, model?: string): ProviderDataPolicy {
    const policy = this.policyFor(provider, model)
    if (!policy.allowsGoogleWorkspaceData) {
      throw new Error(`${policy.displayName} is not approved for Google Workspace content in this OmniCode configuration. Choose a local Ollama model, OpenAI API, or Anthropic API.`)
    }
    return policy
  }
}

export function isGoogleWorkspaceConnector(connectorId: string | undefined): boolean {
  return connectorId === 'gmail' || connectorId === 'google-drive'
}
