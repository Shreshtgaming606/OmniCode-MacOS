import type { JsonValue, ToolDescriptor } from '../../shared/tool-contracts'
import type { OmniCursorApplicationId, OmniCursorUserTakeoverEvent } from '../../shared/omni-cursor-contracts'
import { sanitizeToolResultForModel } from './model-tool-result-sanitizer'
import type { OmniCursorService, OmniCursorSession } from './omni-cursor-service'
import { ToolRegistry, type ToolExecutorContext } from './tool-registry'

type ToolRegistration = { descriptor: ToolDescriptor; execute: Parameters<ToolRegistry['register']>[1] }

export interface OmniComputerToolServiceOptions {
  cursor: OmniCursorService
  onUserTakeover?(taskId: string, event: OmniCursorUserTakeoverEvent): void | Promise<void>
}

function owner(context: ToolExecutorContext): string {
  if (!context.executionId) throw new Error('This computer action is not attached to an active Omni task.')
  return context.executionId
}

function asResult(value: unknown): JsonValue {
  return value as JsonValue
}

/**
 * Structured, task-owned Cursor Mode tools. No shell, AppleScript, selector,
 * or arbitrary native payload crosses this boundary. High-impact pointer and
 * keyboard actions retain a non-bypassable PermissionManager confirmation.
 */
export class OmniComputerToolService {
  readonly #sessions = new Map<string, Promise<OmniCursorSession>>()

  constructor(private readonly options: OmniComputerToolServiceOptions) {}

  register(registry: ToolRegistry): void {
    for (const registration of this.registrations()) registry.register(registration.descriptor, registration.execute)
  }

  async resumeTask(taskId: string): Promise<void> {
    const session = this.#sessions.get(taskId)
    if (!session) return
    const resolved = await session
    if (resolved.state === 'user-takeover') await resolved.resume()
  }

  async cleanupTask(taskId: string): Promise<void> {
    const pending = this.#sessions.get(taskId)
    this.#sessions.delete(taskId)
    if (!pending) return
    const session = await pending.catch(() => null)
    session?.dispose()
  }

  private registrations(): ToolRegistration[] {
    const base = (
      id: string,
      name: string,
      description: string,
      safety: Pick<ToolDescriptor, 'action' | 'category' | 'risk' | 'reversible' | 'externalSideEffect' | 'confirmation'>,
      inputSchema: ToolDescriptor['inputSchema']
    ): ToolDescriptor => ({
      id, name, description, connectorId: 'computer', modes: ['omni'], requiredScopes: ['macos.accessibility'],
      ...safety, inputSchema, timeoutMs: 30_000, maxResultBytes: 32 * 1024
    })
    const read = { action: 'read' as const, category: 'read' as const, risk: 'low' as const, reversible: true, externalSideEffect: false, confirmation: 'never' as const }
    const routine = { action: 'write' as const, category: 'system' as const, risk: 'medium' as const, reversible: true, externalSideEffect: false, confirmation: 'policy' as const }
    const direct = { action: 'sensitive' as const, category: 'system' as const, risk: 'high' as const, reversible: false, externalSideEffect: false, confirmation: 'always' as const }
    const registrations: ToolRegistration[] = []

    registrations.push({
      descriptor: base('computer.observe', 'Observe pointer and active app', 'Read the current pointer position and frontmost allowlisted application metadata.', read, { type: 'object', properties: {}, additionalProperties: false }),
      execute: async (_input, context) => asResult(await (await this.session(context)).observe(context.signal))
    })
    registrations.push({
      descriptor: base('computer.move', 'Move pointer', 'Move the pointer to one validated coordinate on an active display.', routine, {
        type: 'object', properties: {
          x: { type: 'number', minimum: -100_000, maximum: 100_000 },
          y: { type: 'number', minimum: -100_000, maximum: 100_000 },
          durationMs: { type: 'integer', minimum: 0, maximum: 1_000 }
        }, required: ['x', 'y'], additionalProperties: false
      }),
      execute: async (input, context) => asResult(await (await this.session(context)).move({
        x: Number(input.x), y: Number(input.y), ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {})
      }, context.signal))
    })
    for (const [id, name, count] of [['computer.click', 'Click pointer', 1], ['computer.double-click', 'Double-click pointer', 2]] as const) {
      registrations.push({
        descriptor: base(id, name, `${name} at the current pointer location after direct approval.`, direct, {
          type: 'object', properties: { button: { type: 'string', enum: ['left', 'right'] } }, additionalProperties: false
        }),
        execute: async (input, context) => {
          const request = { button: (input.button ?? 'left') as 'left' | 'right' }
          const session = await this.session(context)
          return asResult(await (count === 1 ? session.click(request, context.signal) : session.doubleClick(request, context.signal)))
        }
      })
    }
    registrations.push({
      descriptor: base('computer.scroll', 'Scroll', 'Scroll the frontmost application by bounded horizontal and vertical distances.', routine, {
        type: 'object', properties: {
          deltaX: { type: 'integer', minimum: -2_000, maximum: 2_000 },
          deltaY: { type: 'integer', minimum: -2_000, maximum: 2_000 }
        }, required: ['deltaY'], additionalProperties: false
      }),
      execute: async (input, context) => asResult(await (await this.session(context)).scroll({
        deltaX: typeof input.deltaX === 'number' ? input.deltaX : 0,
        deltaY: Number(input.deltaY)
      }, context.signal))
    })
    registrations.push({
      descriptor: base('computer.type-text', 'Type text', 'Type bounded non-secret text into the frontmost application after direct approval.', {
        action: 'sensitive', category: 'external-submission', risk: 'critical', reversible: false, externalSideEffect: true, confirmation: 'always'
      }, {
        type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 8_192 } }, required: ['text'], additionalProperties: false
      }),
      execute: async (input, context) => {
        const text = String(input.text)
        if (sanitizeToolResultForModel(text) !== text) throw new Error('Omni Cursor Mode never types credentials or secret-looking values.')
        return asResult(await (await this.session(context)).typeText(text, context.signal))
      }
    })
    registrations.push({
      descriptor: base('computer.press-key', 'Press key', 'Press one allowlisted key or shortcut after direct approval.', direct, {
        type: 'object', properties: {
          key: { type: 'string', minLength: 1, maxLength: 32 },
          modifiers: { type: 'array', items: { type: 'string', enum: ['command', 'control', 'option', 'shift', 'function'] }, maxItems: 5 },
          repeat: { type: 'integer', minimum: 1, maximum: 20 }
        }, required: ['key'], additionalProperties: false
      }),
      execute: async (input, context) => asResult(await (await this.session(context)).pressKey({
        key: String(input.key),
        modifiers: Array.isArray(input.modifiers) ? input.modifiers as Array<'command' | 'control' | 'option' | 'shift' | 'function'> : [],
        repeat: typeof input.repeat === 'number' ? input.repeat : 1
      }, context.signal))
    })
    registrations.push({
      descriptor: base('computer.focus-app', 'Focus application', 'Bring one fixed allowlisted application to the foreground.', routine, {
        type: 'object', properties: {
          application: { type: 'string', enum: this.options.cursor.listApplications().map((application) => application.id) }
        }, required: ['application'], additionalProperties: false
      }),
      execute: async (input, context) => asResult(await (await this.session(context)).focusApplication(String(input.application) as OmniCursorApplicationId, context.signal))
    })
    return registrations
  }

  private session(context: ToolExecutorContext): Promise<OmniCursorSession> {
    const taskId = owner(context)
    let session = this.#sessions.get(taskId)
    if (!session) {
      session = this.options.cursor.startSession({
        onUserTakeover: (event) => { void Promise.resolve(this.options.onUserTakeover?.(taskId, event)).catch(() => undefined) }
      })
      this.#sessions.set(taskId, session)
      void session.catch(() => { if (this.#sessions.get(taskId) === session) this.#sessions.delete(taskId) })
    }
    return session
  }
}
