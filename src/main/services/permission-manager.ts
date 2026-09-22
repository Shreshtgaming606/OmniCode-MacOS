import type {
  ConnectorAccessLevel,
  JsonValue,
  ToolAuthorizationDecision,
  ToolConfirmationRequest,
  ToolDescriptor,
  ToolRiskLevel,
  WorkApprovalMode
} from '../../shared/tool-contracts'

export type ConfirmToolAction = (request: ToolConfirmationRequest, signal?: AbortSignal) => Promise<boolean>

export interface ToolAuthorizationContext {
  accessLevel: ConnectorAccessLevel
  approvalMode: WorkApprovalMode
  confirm: ConfirmToolAction
  signal?: AbortSignal
  onDecision?(decision: ToolAuthorizationDecision): void
}

const ACCESS_LEVELS = new Set<ConnectorAccessLevel>(['read-only', 'ask-before-changes', 'trusted'])
const APPROVAL_MODES = new Set<WorkApprovalMode>(['ask', 'auto', 'full'])
const RISK_ORDER: ToolRiskLevel[] = ['low', 'medium', 'high', 'critical']
const CREDENTIAL_FIELD = /(?:password|passcode|secret|token|authorization|credential|private[_-]?key)/iu

const APPROVAL_STRICTNESS: Record<WorkApprovalMode, number> = { ask: 0, auto: 1, full: 2 }

/** Returns the policy that grants no more authority than either input policy. */
export function stricterApprovalMode(left: WorkApprovalMode, right: WorkApprovalMode): WorkApprovalMode {
  if (!APPROVAL_MODES.has(left) || !APPROVAL_MODES.has(right)) throw new Error('The approval policy is invalid.')
  return APPROVAL_STRICTNESS[left] <= APPROVAL_STRICTNESS[right] ? left : right
}

function confirmationSummary(tool: ToolDescriptor): string {
  if (tool.category === 'communication') return `${tool.name} will communicate with people outside this chat.`
  if (tool.category === 'financial') return `${tool.name} can cause a purchase, payment, or financial transfer.`
  if (tool.category === 'account-security') return `${tool.name} can change account access or security settings.`
  if (tool.category === 'destructive') return tool.reversible
    ? `${tool.name} will remove or relocate data, but the service may allow recovery.`
    : `${tool.name} can permanently remove or replace data.`
  if (tool.category === 'sensitive-data') return `${tool.name} can transfer private data to another destination.`
  if (tool.category === 'external-submission') return `${tool.name} will submit information to an external service.`
  if (tool.category === 'system') return `${tool.name} will run an action on this Mac.`
  if (tool.externalSideEffect) return `${tool.name} will change data in ${tool.connectorId}.`
  return `${tool.name} will read bounded data from ${tool.connectorId}.`
}

function higherRisk(left: ToolRiskLevel, right: ToolRiskLevel): ToolRiskLevel {
  return RISK_ORDER.indexOf(left) >= RISK_ORDER.indexOf(right) ? left : right
}

function hasCredentialInput(input: Record<string, JsonValue>): boolean {
  const inspect = (value: JsonValue, key = ''): boolean => {
    if (CREDENTIAL_FIELD.test(key)) return true
    if (Array.isArray(value)) return value.some((entry) => inspect(entry))
    if (value && typeof value === 'object') return Object.entries(value).some(([name, entry]) => inspect(entry, name))
    return false
  }
  return inspect(input)
}

function isBulkAction(tool: ToolDescriptor, input: Record<string, JsonValue>): boolean {
  const arrays = Object.values(input).filter(Array.isArray)
  const largest = arrays.reduce((count, value) => Math.max(count, value.length), 0)
  if (tool.category === 'communication') {
    const recipients = ['to', 'cc', 'bcc'].reduce((count, key) => count + (Array.isArray(input[key]) ? input[key].length : 0), 0)
    return recipients > 5 || largest > 10
  }
  return largest > 20
}

function evaluatedRisk(tool: ToolDescriptor, input: Record<string, JsonValue>): ToolRiskLevel {
  let risk = tool.risk
  if (hasCredentialInput(input)) risk = 'critical'
  if (isBulkAction(tool, input)) risk = higherRisk(risk, 'critical')
  return risk
}

function hardBoundary(tool: ToolDescriptor, risk: ToolRiskLevel): string | undefined {
  if (risk === 'critical') return 'Critical actions always require direct approval.'
  if (tool.category === 'financial') return 'Financial actions always require direct approval.'
  if (tool.category === 'account-security') return 'Account and security changes always require direct approval.'
  if (tool.category === 'destructive' && !tool.reversible) return 'Irreversible destructive actions always require direct approval.'
  if (tool.confirmation === 'always') return 'This action has a non-bypassable confirmation requirement.'
  return undefined
}

function policyRequirement(tool: ToolDescriptor, mode: WorkApprovalMode, risk: ToolRiskLevel): string | undefined {
  const hard = hardBoundary(tool, risk)
  if (hard) return hard
  if (mode === 'full') return undefined
  if (mode === 'ask') {
    if (tool.category === 'read' && !tool.externalSideEffect && tool.action === 'read') return undefined
    return 'Ask for approval is enabled for changes and external actions.'
  }
  if (tool.category === 'read' && !tool.externalSideEffect && tool.action === 'read') return undefined
  if (risk === 'low' && tool.reversible && !['communication', 'external-submission', 'sensitive-data', 'destructive'].includes(tool.category)) return undefined
  if (tool.category === 'communication') return 'External communication requires approval in Approve for me mode.'
  if (tool.category === 'external-submission') return 'External submissions require approval in Approve for me mode.'
  if (tool.category === 'sensitive-data') return 'Transferring sensitive data requires approval in Approve for me mode.'
  if (tool.category === 'destructive') return 'Destructive actions require approval in Approve for me mode.'
  return `${risk[0].toUpperCase()}${risk.slice(1)}-risk actions require approval in Approve for me mode.`
}

export class PermissionManager {
  async authorize(
    tool: ToolDescriptor,
    input: Record<string, JsonValue>,
    context: ToolAuthorizationContext
  ): Promise<ToolAuthorizationDecision> {
    if (!context || !ACCESS_LEVELS.has(context.accessLevel) || !APPROVAL_MODES.has(context.approvalMode) || typeof context.confirm !== 'function') {
      throw new Error('The connector authorization policy is invalid.')
    }
    if (context.signal?.aborted) throw context.signal.reason ?? new DOMException('Action cancelled.', 'AbortError')
    if (tool.action !== 'read' && context.accessLevel === 'read-only') {
      const decision: ToolAuthorizationDecision = {
        approvalMode: context.approvalMode,
        risk: evaluatedRisk(tool, input),
        requiredApproval: false,
        userApproved: false,
        reason: `${tool.connectorId} is restricted to read-only access.`
      }
      context.onDecision?.(decision)
      throw new Error(`${tool.name} is blocked because ${tool.connectorId} is configured as read only.`)
    }

    const risk = evaluatedRisk(tool, input)
    const reason = policyRequirement(tool, context.approvalMode, risk)
    if (!reason) {
      const decision: ToolAuthorizationDecision = {
        approvalMode: context.approvalMode,
        risk,
        requiredApproval: false,
        userApproved: false,
        reason: `${tool.name} is allowed automatically by the current Work approval policy.`
      }
      context.onDecision?.(decision)
      return decision
    }

    const approved = await context.confirm({
      toolId: tool.id,
      toolName: tool.name,
      connectorId: tool.connectorId,
      action: tool.action,
      category: tool.category,
      risk,
      approvalMode: context.approvalMode,
      summary: confirmationSummary(tool),
      reason,
      input
    }, context.signal)
    const decision: ToolAuthorizationDecision = {
      approvalMode: context.approvalMode,
      risk,
      requiredApproval: true,
      userApproved: approved === true,
      reason
    }
    context.onDecision?.(decision)
    if (approved !== true) throw new Error(`${tool.name} was cancelled before any action was taken.`)
    return decision
  }
}
