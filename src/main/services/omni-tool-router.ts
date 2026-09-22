import type { OmniExecutionMode } from '../../shared/omni-contracts'
import type {
  JsonValue,
  ToolAuthorizationDecision,
  ToolConfirmationRequest,
  ToolDescriptor,
  ToolExecutionRequest,
  ToolExecutionResult,
  WorkApprovalMode
} from '../../shared/tool-contracts'

export interface OmniToolRouteContext {
  taskId: string
  executionMode: OmniExecutionMode
  approvalMode: WorkApprovalMode
  signal: AbortSignal
  confirm(request: ToolConfirmationRequest, signal?: AbortSignal): Promise<boolean>
  onDecision?(decision: ToolAuthorizationDecision): void
  onProgress?(value: JsonValue): void
}

export interface OmniToolRoute {
  /** Descriptor owned by the original Code, Work, or native tool service. */
  descriptor: ToolDescriptor
  /** Optional public ID used to resolve otherwise-colliding tools. */
  publicId?: string
  /** Mode supplied to the original registry. The public request remains `omni`. */
  targetMode: 'code' | 'work' | 'omni'
  /** Cursor-only routes are never allowed while the task remains Invisible. */
  executionModes?: readonly OmniExecutionMode[]
  execute(request: ToolExecutionRequest, context: OmniToolRouteContext): Promise<ToolExecutionResult>
}

interface RegisteredOmniRoute {
  descriptor: ToolDescriptor
  sourceToolId: string
  targetMode: 'code' | 'work' | 'omni'
  executionModes: ReadonlySet<OmniExecutionMode>
  execute: OmniToolRoute['execute']
}

const PUBLIC_TOOL_ID = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/u

function publicDescriptor(route: OmniToolRoute): ToolDescriptor {
  const id = route.publicId ?? route.descriptor.id
  if (!PUBLIC_TOOL_ID.test(id)) throw new Error('Omni tool aliases must use connector.action form.')
  return Object.freeze({
    ...route.descriptor,
    id,
    modes: Object.freeze(['omni'] as const),
    requiredScopes: Object.freeze([...route.descriptor.requiredScopes])
  })
}

/**
 * Collision-safe facade over the already-audited Code and Work registries.
 *
 * This class deliberately does not execute a tool itself and does not make an
 * authorization decision. It maps one public Omni tool ID to exactly one
 * existing registry route; that route must still perform its normal schema,
 * connector, scope, and PermissionManager checks. This prevents a combined
 * Omni catalog from weakening either source registry or authorizing twice.
 */
export class OmniToolRouter {
  readonly #routes = new Map<string, RegisteredOmniRoute>()

  constructor(routes: readonly OmniToolRoute[] = []) {
    for (const route of routes) this.register(route)
  }

  register(route: OmniToolRoute): void {
    if (!route || !route.descriptor || typeof route.execute !== 'function') throw new Error('Omni tool route is invalid.')
    if (route.targetMode !== 'code' && route.targetMode !== 'work' && route.targetMode !== 'omni') {
      throw new Error('Omni tools must route through a registered Code, Work, or Omni policy.')
    }
    const descriptor = publicDescriptor(route)
    if (this.#routes.has(descriptor.id)) throw new Error(`Omni tool ${descriptor.id} is already registered.`)
    const modes = new Set<OmniExecutionMode>(route.executionModes ?? ['invisible', 'cursor'])
    if (!modes.size || [...modes].some((mode) => mode !== 'invisible' && mode !== 'cursor')) {
      throw new Error('Omni tool execution modes are invalid.')
    }
    this.#routes.set(descriptor.id, {
      descriptor,
      sourceToolId: route.descriptor.id,
      targetMode: route.targetMode,
      executionModes: modes,
      execute: route.execute
    })
  }

  list(executionMode: OmniExecutionMode): ToolDescriptor[] {
    if (executionMode !== 'invisible' && executionMode !== 'cursor') throw new Error('Choose Invisible or Cursor execution.')
    return [...this.#routes.values()]
      .filter((route) => route.executionModes.has(executionMode))
      .map((route) => ({
        ...route.descriptor,
        modes: [...route.descriptor.modes],
        requiredScopes: [...route.descriptor.requiredScopes]
      }))
  }

  async execute(request: ToolExecutionRequest, context: OmniToolRouteContext): Promise<ToolExecutionResult> {
    if (!request || request.mode !== 'omni') throw new Error('The Omni tool router accepts only Omni requests.')
    const route = this.#routes.get(request.toolId)
    if (!route) throw new Error('The requested Omni tool is not registered.')
    if (!route.executionModes.has(context.executionMode)) {
      throw new Error(`${route.descriptor.name} is not available in ${context.executionMode === 'invisible' ? 'Invisible' : 'Cursor'} Mode.`)
    }
    if (context.signal.aborted) throw context.signal.reason ?? new DOMException('Omni task stopped.', 'AbortError')
    const result = await route.execute({
      toolId: route.sourceToolId,
      mode: route.targetMode,
      input: request.input
    }, context)
    if (!result || result.toolId !== route.sourceToolId) throw new Error('An Omni tool route returned a result for the wrong tool.')
    return { ...result, toolId: route.descriptor.id }
  }
}
