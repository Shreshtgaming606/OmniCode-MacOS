import type {
  ConnectorAccessLevel,
  JsonValue,
  ToolConfirmationRequest,
  ToolDescriptor
} from '../../shared/tool-contracts'

export type ConfirmToolAction = (request: ToolConfirmationRequest) => Promise<boolean>

export interface ToolAuthorizationContext {
  accessLevel: ConnectorAccessLevel
  confirm: ConfirmToolAction
}

const ACCESS_LEVELS = new Set<ConnectorAccessLevel>([
  'read-only',
  'ask-before-changes',
  'trusted'
])

function confirmationSummary(tool: ToolDescriptor): string {
  if (tool.action === 'destructive') return `${tool.name} can permanently remove or replace data.`
  if (tool.action === 'sensitive') return `${tool.name} can disclose or change sensitive account data.`
  if (tool.action === 'write') return `${tool.name} will change data in ${tool.connectorId}.`
  return `${tool.name} will read data from ${tool.connectorId}.`
}

export class PermissionManager {
  async authorize(
    tool: ToolDescriptor,
    input: Record<string, JsonValue>,
    context: ToolAuthorizationContext
  ): Promise<void> {
    if (!context || !ACCESS_LEVELS.has(context.accessLevel) || typeof context.confirm !== 'function') {
      throw new Error('The connector authorization policy is invalid.')
    }
    if (tool.action !== 'read' && context.accessLevel === 'read-only') {
      throw new Error(`${tool.name} is blocked because ${tool.connectorId} is configured as read only.`)
    }

    const mustConfirm = tool.confirmation === 'always' ||
      tool.action === 'destructive' ||
      tool.action === 'sensitive' ||
      (tool.action === 'write' && context.accessLevel === 'ask-before-changes')

    if (!mustConfirm) return
    const approved = await context.confirm({
      toolId: tool.id,
      toolName: tool.name,
      connectorId: tool.connectorId,
      action: tool.action,
      summary: confirmationSummary(tool),
      input
    })
    if (approved !== true) throw new Error(`${tool.name} was cancelled before any action was taken.`)
  }
}
