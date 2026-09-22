import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { app, systemPreferences } from 'electron'

import {
  OMNI_CURSOR_LIMITS,
  type OmniCursorActionResult,
  type OmniCursorApplicationId,
  type OmniCursorButton,
  type OmniCursorClickRequest,
  type OmniCursorModifier,
  type OmniCursorMoveRequest,
  type OmniCursorObservation,
  type OmniCursorPermissionStatus,
  type OmniCursorPoint,
  type OmniCursorPressKeyRequest,
  type OmniCursorScrollRequest,
  type OmniCursorSessionState,
  type OmniCursorUserTakeoverEvent
} from '../../shared/omni-cursor-contracts'
import { redactOmniActivityText } from './omni-task-store'

const NATIVE_HELPER_NAME = 'omnicode-cursor-helper'
const APPLICATIONS: Readonly<Record<OmniCursorApplicationId, { name: string; bundleIdentifier: string }>> = {
  omnicode: { name: 'OmniCode', bundleIdentifier: 'com.omnicode.editor' },
  finder: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  safari: { name: 'Safari', bundleIdentifier: 'com.apple.Safari' },
  chrome: { name: 'Google Chrome', bundleIdentifier: 'com.google.Chrome' },
  mail: { name: 'Mail', bundleIdentifier: 'com.apple.mail' },
  calendar: { name: 'Calendar', bundleIdentifier: 'com.apple.iCal' },
  notes: { name: 'Notes', bundleIdentifier: 'com.apple.Notes' },
  terminal: { name: 'Terminal', bundleIdentifier: 'com.apple.Terminal' },
  xcode: { name: 'Xcode', bundleIdentifier: 'com.apple.dt.Xcode' },
  simulator: { name: 'Simulator', bundleIdentifier: 'com.apple.iphonesimulator' },
  preview: { name: 'Preview', bundleIdentifier: 'com.apple.Preview' },
  textedit: { name: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit' }
}

const NAMED_KEYS = new Set([
  'return', 'escape', 'tab', 'space', 'delete', 'forward-delete',
  'left', 'right', 'up', 'down', 'home', 'end', 'page-up', 'page-down',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'
])
const MODIFIERS = new Set<OmniCursorModifier>(['command', 'control', 'option', 'shift', 'function'])
const MODIFIER_ORDER: OmniCursorModifier[] = ['command', 'control', 'option', 'shift', 'function']

export type OmniCursorNativeCommand =
  | { command: 'observe' }
  | { command: 'move'; x: number; y: number; durationMs: number }
  | { command: 'click'; button: OmniCursorButton; count: 1 | 2 }
  | { command: 'scroll'; deltaX: number; deltaY: number }
  | { command: 'type-text'; text: string }
  | { command: 'press-key'; key: string; modifiers: OmniCursorModifier[]; repeat: number }
  | { command: 'focus-application'; bundleIdentifier: string }

export type OmniCursorNativeErrorCode =
  | 'accessibility-denied'
  | 'application-not-running'
  | 'execution-failed'
  | 'helper-missing'
  | 'invalid-request'
  | 'invalid-response'
  | 'timed-out'
  | 'user-takeover'

export class OmniCursorNativeError extends Error {
  constructor(
    readonly code: OmniCursorNativeErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'OmniCursorNativeError'
  }
}

export interface OmniCursorNativeAdapter {
  available(): Promise<boolean>
  execute(command: OmniCursorNativeCommand, signal?: AbortSignal): Promise<unknown>
}

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams

export interface OmniCursorHelperAdapterOptions {
  helperPath: string
  spawnProcess?: SpawnProcess
  accessFile?: (filePath: string, mode?: number) => Promise<void>
  timeoutMs?: number
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Cursor control was cancelled.', 'AbortError')
}

function safeNativeMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  return redactOmniActivityText(value, 320).replace(/\s+/gu, ' ').trim() || fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nativeErrorCode(value: unknown): OmniCursorNativeErrorCode {
  return value === 'accessibility-denied' || value === 'application-not-running' || value === 'execution-failed' ||
    value === 'invalid-request' || value === 'user-takeover'
    ? value
    : 'execution-failed'
}

/**
 * One-request-per-process adapter for the fixed native helper. The helper path
 * is supplied by trusted application code, no shell is opened, process output
 * is bounded, and abort/timeout always terminate the child.
 */
export class OmniCursorHelperAdapter implements OmniCursorNativeAdapter {
  readonly #helperPath: string
  readonly #spawnProcess: SpawnProcess
  readonly #accessFile: (filePath: string, mode?: number) => Promise<void>
  readonly #timeoutMs: number

  constructor(options: OmniCursorHelperAdapterOptions) {
    if (!path.isAbsolute(options.helperPath) || options.helperPath.includes('\0')) {
      throw new Error('The Omni cursor helper path must be absolute.')
    }
    this.#helperPath = options.helperPath
    this.#spawnProcess = options.spawnProcess ?? spawn as SpawnProcess
    this.#accessFile = options.accessFile ?? access
    this.#timeoutMs = Number.isInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.min(options.timeoutMs!, 60_000)
      : OMNI_CURSOR_LIMITS.helperTimeoutMs
  }

  async available(): Promise<boolean> {
    try {
      await this.#accessFile(this.#helperPath, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }

  async execute(command: OmniCursorNativeCommand, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError(signal)
    if (!await this.available()) {
      throw new OmniCursorNativeError('helper-missing', 'The signed Omni cursor helper is unavailable. Reinstall OmniCode or rebuild the native helper.')
    }
    if (signal?.aborted) throw abortError(signal)

    const id = randomUUID()
    const input = JSON.stringify({ version: 1, id, ...command })
    if (Buffer.byteLength(input) > OMNI_CURSOR_LIMITS.helperRequestBytes) {
      throw new OmniCursorNativeError('invalid-request', 'The cursor control request is too large.')
    }

    return await new Promise<unknown>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.#spawnProcess(this.#helperPath, [], {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (error) {
        reject(new OmniCursorNativeError('helper-missing', safeNativeMessage(error instanceof Error ? error.message : '', 'The Omni cursor helper could not start.')))
        return
      }

      let stdout = ''
      let stderrBytes = 0
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        callback()
      }
      const fail = (error: unknown, terminate = false): void => {
        if (terminate) child.kill('SIGTERM')
        finish(() => reject(error))
      }
      const onAbort = (): void => fail(abortError(signal), true)
      const timeout = setTimeout(() => {
        fail(new OmniCursorNativeError('timed-out', 'The cursor control helper did not respond in time.'), true)
      }, this.#timeoutMs)
      timeout.unref?.()

      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) return
        stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        if (Buffer.byteLength(stdout) > OMNI_CURSOR_LIMITS.helperResponseBytes) {
          fail(new OmniCursorNativeError('invalid-response', 'The cursor control helper returned too much data.'), true)
        }
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (settled) return
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > OMNI_CURSOR_LIMITS.helperResponseBytes) {
          fail(new OmniCursorNativeError('invalid-response', 'The cursor control helper returned too much diagnostic data.'), true)
        }
      })
      child.stdin.once('error', (error) => fail(new OmniCursorNativeError('execution-failed', safeNativeMessage(error.message, 'The cursor control helper rejected its request.')), true))
      child.stdout.once('error', (error) => fail(new OmniCursorNativeError('execution-failed', safeNativeMessage(error.message, 'The cursor control helper output failed.')), true))
      child.stderr.once('error', (error) => fail(new OmniCursorNativeError('execution-failed', safeNativeMessage(error.message, 'The cursor control helper diagnostic stream failed.')), true))
      child.once('error', (error) => fail(new OmniCursorNativeError('helper-missing', safeNativeMessage(error.message, 'The cursor control helper could not start.'))))
      child.once('close', () => {
        if (settled) return
        if (signal?.aborted) {
          fail(abortError(signal))
          return
        }
        let response: unknown
        try {
          response = JSON.parse(stdout.trim())
        } catch {
          fail(new OmniCursorNativeError('invalid-response', 'The cursor control helper returned an invalid response.'))
          return
        }
        if (!isRecord(response) || response.version !== 1 || response.id !== id || typeof response.ok !== 'boolean') {
          fail(new OmniCursorNativeError('invalid-response', 'The cursor control helper response could not be verified.'))
          return
        }
        if (!response.ok) {
          const error = isRecord(response.error) ? response.error : {}
          fail(new OmniCursorNativeError(
            nativeErrorCode(error.code),
            safeNativeMessage(error.message, 'The cursor control action failed.'),
            error.details
          ))
          return
        }
        finish(() => resolve(response.result))
      })

      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      child.stdin.end(`${input}\n`, 'utf8')
    })
  }
}

export interface ResolveOmniCursorHelperPathOptions {
  packaged: boolean
  resourcesPath: string
  appPath: string
}

export function resolveOmniCursorHelperPath(options: ResolveOmniCursorHelperPathOptions): string {
  return options.packaged
    ? path.join(options.resourcesPath, 'omni-native', NATIVE_HELPER_NAME)
    : path.join(options.appPath, 'out', 'native', NATIVE_HELPER_NAME)
}

function defaultHelperPath(): string {
  let appPath = process.cwd()
  let packaged = false
  try {
    appPath = app.getAppPath()
    packaged = app.isPackaged
  } catch {
    // Tests and early startup can supply an adapter or explicit helper path.
  }
  return resolveOmniCursorHelperPath({ packaged, resourcesPath: process.resourcesPath, appPath })
}

export interface OmniCursorServiceOptions {
  platform?: NodeJS.Platform
  accessibilityTrusted?: () => boolean
  adapter?: OmniCursorNativeAdapter
  helperPath?: string
  now?: () => number
}

function assertFiniteNumber(value: unknown, label: string, magnitude = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > magnitude) {
    throw new Error(`${label} must be a finite number within the supported range.`)
  }
  return value
}

function assertInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`)
  }
  return value
}

function parsePoint(value: unknown): OmniCursorPoint {
  if (!isRecord(value)) throw new OmniCursorNativeError('invalid-response', 'The cursor helper omitted its pointer location.')
  return {
    x: assertFiniteNumber(value.x, 'Cursor x-coordinate', OMNI_CURSOR_LIMITS.coordinateMagnitude),
    y: assertFiniteNumber(value.y, 'Cursor y-coordinate', OMNI_CURSOR_LIMITS.coordinateMagnitude)
  }
}

function parseWindowFrame(value: unknown): OmniCursorObservation['frontmostWindow'] {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new OmniCursorNativeError('invalid-response', 'The cursor helper returned invalid window geometry.')
  const width = assertFiniteNumber(value.width, 'Frontmost window width', OMNI_CURSOR_LIMITS.coordinateMagnitude)
  const height = assertFiniteNumber(value.height, 'Frontmost window height', OMNI_CURSOR_LIMITS.coordinateMagnitude)
  if (width <= 0 || height <= 0) throw new OmniCursorNativeError('invalid-response', 'The cursor helper returned invalid window geometry.')
  return {
    ...parsePoint(value),
    width,
    height
  }
}

function parseObservation(value: unknown): OmniCursorObservation {
  if (!isRecord(value)) throw new OmniCursorNativeError('invalid-response', 'The cursor helper omitted its observation.')
  const observedAt = assertFiniteNumber(value.observedAt, 'Observation timestamp')
  let frontmostApplication: OmniCursorObservation['frontmostApplication'] = null
  if (value.frontmostApplication !== null && value.frontmostApplication !== undefined) {
    if (!isRecord(value.frontmostApplication)) throw new OmniCursorNativeError('invalid-response', 'The cursor helper returned an invalid application observation.')
    const application = value.frontmostApplication
    const name = application.name === null ? null : typeof application.name === 'string' && application.name.length <= 256 ? application.name : undefined
    const bundleIdentifier = application.bundleIdentifier === null
      ? null
      : typeof application.bundleIdentifier === 'string' && /^[A-Za-z0-9.-]{1,256}$/u.test(application.bundleIdentifier)
        ? application.bundleIdentifier
        : undefined
    if (name === undefined || bundleIdentifier === undefined || !Number.isInteger(application.processIdentifier) || (application.processIdentifier as number) < 0) {
      throw new OmniCursorNativeError('invalid-response', 'The cursor helper returned an invalid application observation.')
    }
    frontmostApplication = { name, bundleIdentifier, processIdentifier: application.processIdentifier as number }
  }
  return {
    cursor: parsePoint(value.cursor),
    frontmostApplication,
    frontmostWindow: parseWindowFrame(value.frontmostWindow),
    observedAt
  }
}

function parseActionResult(value: unknown): OmniCursorActionResult {
  if (!isRecord(value)) throw new OmniCursorNativeError('invalid-response', 'The cursor helper omitted its action result.')
  return { observation: parseObservation(value.observation) }
}

function validKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Choose an allowlisted keyboard key.')
  const key = value.toLowerCase()
  if (!NAMED_KEYS.has(key) && !/^[a-z0-9]$/u.test(key)) throw new Error('Choose an allowlisted keyboard key.')
  return key
}

function validModifiers(value: unknown): OmniCursorModifier[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !MODIFIERS.has(item as OmniCursorModifier))) {
    throw new Error('Choose only allowlisted keyboard modifiers.')
  }
  const unique = new Set(value as OmniCursorModifier[])
  return MODIFIER_ORDER.filter((modifier) => unique.has(modifier))
}

function distance(left: OmniCursorPoint, right: OmniCursorPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

interface LinkedSignal {
  signal?: AbortSignal
  cleanup(): void
}

function linkSignals(signals: Array<AbortSignal | undefined>): LinkedSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (!active.length) return { signal: undefined, cleanup: () => undefined }
  if (active.length === 1) return { signal: active[0], cleanup: () => undefined }
  const controller = new AbortController()
  const listeners = active.map((signal) => {
    const listener = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason ?? new DOMException('Cursor control was cancelled.', 'AbortError'))
    }
    signal.addEventListener('abort', listener, { once: true })
    if (signal.aborted) listener()
    return { signal, listener }
  })
  return {
    signal: controller.signal,
    cleanup: () => listeners.forEach(({ signal, listener }) => signal.removeEventListener('abort', listener))
  }
}

export class OmniCursorService {
  readonly #platform: NodeJS.Platform
  readonly #accessibilityTrusted: () => boolean
  readonly #adapter: OmniCursorNativeAdapter
  readonly #now: () => number

  constructor(options: OmniCursorServiceOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#accessibilityTrusted = options.accessibilityTrusted ?? (() => systemPreferences.isTrustedAccessibilityClient(false))
    this.#adapter = options.adapter ?? new OmniCursorHelperAdapter({ helperPath: options.helperPath ?? defaultHelperPath() })
    this.#now = options.now ?? Date.now
  }

  listApplications(): Array<{ id: OmniCursorApplicationId; name: string }> {
    return (Object.entries(APPLICATIONS) as Array<[OmniCursorApplicationId, (typeof APPLICATIONS)[OmniCursorApplicationId]]>)
      .map(([id, application]) => ({ id, name: application.name }))
  }

  async permissions(): Promise<OmniCursorPermissionStatus> {
    if (this.#platform !== 'darwin') {
      return { accessibility: 'unavailable', nativeHelper: 'unavailable', checkedAt: this.#now() }
    }
    let accessibility: OmniCursorPermissionStatus['accessibility'] = 'denied'
    try { accessibility = this.#accessibilityTrusted() ? 'granted' : 'denied' } catch { accessibility = 'unavailable' }
    const nativeHelper = await this.#adapter.available().then((available) => available ? 'available' as const : 'missing' as const).catch(() => 'missing' as const)
    return { accessibility, nativeHelper, checkedAt: this.#now() }
  }

  async observe(signal?: AbortSignal): Promise<OmniCursorObservation> {
    this.#assertAuthorized(signal)
    return parseObservation(await this.#adapter.execute({ command: 'observe' }, signal))
  }

  async move(request: OmniCursorMoveRequest, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    this.#assertAuthorized(signal)
    if (!isRecord(request)) throw new Error('Choose a valid cursor destination.')
    const x = assertFiniteNumber(request.x, 'Cursor x-coordinate', OMNI_CURSOR_LIMITS.coordinateMagnitude)
    const y = assertFiniteNumber(request.y, 'Cursor y-coordinate', OMNI_CURSOR_LIMITS.coordinateMagnitude)
    const durationMs = request.durationMs === undefined
      ? 120
      : assertInteger(request.durationMs, 'Cursor movement duration', 0, OMNI_CURSOR_LIMITS.movementDurationMs)
    return parseActionResult(await this.#adapter.execute({ command: 'move', x, y, durationMs }, signal))
  }

  async click(request: OmniCursorClickRequest = {}, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return await this.#click(request, 1, signal)
  }

  async doubleClick(request: OmniCursorClickRequest = {}, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return await this.#click(request, 2, signal)
  }

  async scroll(request: OmniCursorScrollRequest, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    this.#assertAuthorized(signal)
    if (!isRecord(request)) throw new Error('Choose a valid scroll distance.')
    const deltaX = request.deltaX === undefined ? 0 : assertInteger(request.deltaX, 'Horizontal scroll distance', -OMNI_CURSOR_LIMITS.scrollDelta, OMNI_CURSOR_LIMITS.scrollDelta)
    const deltaY = assertInteger(request.deltaY, 'Vertical scroll distance', -OMNI_CURSOR_LIMITS.scrollDelta, OMNI_CURSOR_LIMITS.scrollDelta)
    if (deltaX === 0 && deltaY === 0) throw new Error('Choose a non-zero scroll distance.')
    return parseActionResult(await this.#adapter.execute({ command: 'scroll', deltaX, deltaY }, signal))
  }

  async typeText(text: string, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    this.#assertAuthorized(signal)
    if (typeof text !== 'string' || !text || text.includes('\0')) throw new Error('Enter valid text for Cursor Mode to type.')
    if (Array.from(text).length > OMNI_CURSOR_LIMITS.textCharacters) throw new Error('Cursor Mode can type at most 8,192 characters in one action.')
    return parseActionResult(await this.#adapter.execute({ command: 'type-text', text }, signal))
  }

  async pressKey(request: OmniCursorPressKeyRequest, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    this.#assertAuthorized(signal)
    if (!isRecord(request)) throw new Error('Choose a valid keyboard action.')
    const key = validKey(request.key)
    const modifiers = validModifiers(request.modifiers)
    const repeat = request.repeat === undefined ? 1 : assertInteger(request.repeat, 'Key repeat count', 1, OMNI_CURSOR_LIMITS.keyRepeats)
    return parseActionResult(await this.#adapter.execute({ command: 'press-key', key, modifiers, repeat }, signal))
  }

  async focusApplication(applicationId: OmniCursorApplicationId, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    this.#assertAuthorized(signal)
    const application = APPLICATIONS[applicationId]
    if (!application) throw new Error('Choose an allowlisted application for Cursor Mode.')
    return parseActionResult(await this.#adapter.execute({ command: 'focus-application', bundleIdentifier: application.bundleIdentifier }, signal))
  }

  async startSession(options: OmniCursorSessionOptions = {}): Promise<OmniCursorSession> {
    const initial = await this.observe(options.signal)
    return new OmniCursorSession(this, initial, options)
  }

  #assertAuthorized(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal)
    if (this.#platform !== 'darwin') throw new Error('Omni Cursor Mode currently requires macOS.')
    let trusted = false
    try { trusted = this.#accessibilityTrusted() } catch { trusted = false }
    if (!trusted) {
      throw new OmniCursorNativeError('accessibility-denied', 'Omni Cursor Mode is blocked until Accessibility permission is granted in System Settings.')
    }
  }

  async #click(request: OmniCursorClickRequest, count: 1 | 2, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    this.#assertAuthorized(signal)
    if (!isRecord(request)) throw new Error('Choose a valid cursor click.')
    const button = request.button ?? 'left'
    if (button !== 'left' && button !== 'right') throw new Error('Cursor Mode supports only left and right clicks.')
    return parseActionResult(await this.#adapter.execute({ command: 'click', button, count }, signal))
  }
}

export interface OmniCursorSessionOptions {
  signal?: AbortSignal
  detectUserTakeover?: boolean
  takeoverPollIntervalMs?: number
  takeoverTolerancePixels?: number
  onUserTakeover?(event: OmniCursorUserTakeoverEvent): void
}

/**
 * A cancellable Cursor Mode session. Pointer movement outside an executing
 * action is treated as human takeover; smooth native moves also report direct
 * takeover when the pointer diverges from the helper's last posted position.
 */
export class OmniCursorSession {
  readonly #service: OmniCursorService
  readonly #options: OmniCursorSessionOptions
  readonly #pollIntervalMs: number
  readonly #tolerancePixels: number
  #state: OmniCursorSessionState = 'active'
  #control = new AbortController()
  #baseline: OmniCursorPoint
  #busy = false
  #polling = false
  #timer: NodeJS.Timeout | null = null
  #externalAbortCleanup: () => void = () => undefined

  constructor(service: OmniCursorService, initial: OmniCursorObservation, options: OmniCursorSessionOptions = {}) {
    this.#service = service
    this.#options = options
    this.#baseline = initial.cursor
    this.#pollIntervalMs = assertInteger(options.takeoverPollIntervalMs ?? OMNI_CURSOR_LIMITS.takeoverPollIntervalMs, 'Takeover polling interval', 50, 2_000)
    this.#tolerancePixels = assertFiniteNumber(options.takeoverTolerancePixels ?? OMNI_CURSOR_LIMITS.takeoverTolerancePixels, 'Takeover tolerance', 100)
    if (this.#tolerancePixels < 1) throw new Error('Takeover tolerance must be at least one pixel.')
    if (options.signal) {
      const onAbort = (): void => this.stop(options.signal?.reason)
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.#externalAbortCleanup = () => options.signal?.removeEventListener('abort', onAbort)
      if (options.signal.aborted) onAbort()
    }
    this.#startMonitor()
  }

  get state(): OmniCursorSessionState { return this.#state }

  observe(signal?: AbortSignal): Promise<OmniCursorObservation> {
    return this.#run((linked) => this.#service.observe(linked), signal)
  }

  move(request: OmniCursorMoveRequest, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return this.#run((linked) => this.#service.move(request, linked), signal)
  }

  click(request: OmniCursorClickRequest = {}, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return this.#run((linked) => this.#service.click(request, linked), signal)
  }

  doubleClick(request: OmniCursorClickRequest = {}, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return this.#run((linked) => this.#service.doubleClick(request, linked), signal)
  }

  scroll(request: OmniCursorScrollRequest, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return this.#run((linked) => this.#service.scroll(request, linked), signal)
  }

  typeText(text: string, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return this.#run((linked) => this.#service.typeText(text, linked), signal)
  }

  pressKey(request: OmniCursorPressKeyRequest, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return this.#run((linked) => this.#service.pressKey(request, linked), signal)
  }

  focusApplication(applicationId: OmniCursorApplicationId, signal?: AbortSignal): Promise<OmniCursorActionResult> {
    return this.#run((linked) => this.#service.focusApplication(applicationId, linked), signal)
  }

  async resume(): Promise<void> {
    if (this.#state !== 'user-takeover') throw new Error('Cursor Mode can resume only after a user takeover pause.')
    if (this.#options.signal?.aborted) throw abortError(this.#options.signal)
    this.#control = new AbortController()
    const observation = await this.#service.observe(this.#options.signal)
    this.#baseline = observation.cursor
    this.#state = 'active'
    this.#startMonitor()
  }

  stop(reason: unknown = new DOMException('Cursor control stopped.', 'AbortError')): void {
    if (this.#state === 'stopped') return
    this.#state = 'stopped'
    this.#stopMonitor()
    if (!this.#control.signal.aborted) this.#control.abort(reason)
    this.#externalAbortCleanup()
  }

  dispose(): void { this.stop() }

  async #run<T extends OmniCursorObservation | OmniCursorActionResult>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#state === 'user-takeover') throw new Error('Omni Cursor Mode is paused because you took control. Resume or stop the task.')
    if (this.#state === 'stopped') throw new DOMException('Cursor control stopped.', 'AbortError')
    const linked = linkSignals([this.#control.signal, this.#options.signal, signal])
    this.#busy = true
    try {
      const result = await operation(linked.signal)
      const observation = ('observation' in result ? result.observation : result) as OmniCursorObservation
      this.#baseline = observation.cursor
      return result
    } catch (error) {
      if (error instanceof OmniCursorNativeError && error.code === 'user-takeover') {
        const details = isRecord(error.details) ? error.details : {}
        const previousCursor = (() => { try { return parsePoint(details.previousCursor) } catch { return this.#baseline } })()
        const currentCursor = (() => { try { return parsePoint(details.currentCursor) } catch { return previousCursor } })()
        this.#claimUserTakeover({ reason: 'native-detection', observedAt: Date.now(), previousCursor, currentCursor })
      }
      throw error
    } finally {
      this.#busy = false
      linked.cleanup()
    }
  }

  #startMonitor(): void {
    if (this.#options.detectUserTakeover === false || this.#state !== 'active' || this.#timer) return
    this.#timer = setInterval(() => { void this.#pollForTakeover() }, this.#pollIntervalMs)
    this.#timer.unref?.()
  }

  #stopMonitor(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  async #pollForTakeover(): Promise<void> {
    if (this.#state !== 'active' || this.#busy || this.#polling) return
    this.#polling = true
    try {
      const observation = await this.#service.observe(this.#control.signal)
      if (this.#state !== 'active' || this.#busy) return
      if (distance(this.#baseline, observation.cursor) > this.#tolerancePixels) {
        this.#claimUserTakeover({
          reason: 'pointer-moved',
          observedAt: observation.observedAt,
          previousCursor: this.#baseline,
          currentCursor: observation.cursor
        })
      } else {
        this.#baseline = observation.cursor
      }
    } catch {
      // Permission/helper failures are surfaced by the next requested action;
      // a monitoring diagnostic must not manufacture a successful operation.
    } finally {
      this.#polling = false
    }
  }

  #claimUserTakeover(event: OmniCursorUserTakeoverEvent): void {
    if (this.#state !== 'active') return
    this.#state = 'user-takeover'
    this.#stopMonitor()
    if (!this.#control.signal.aborted) this.#control.abort(new DOMException('Cursor control paused because the user took control.', 'AbortError'))
    try { this.#options.onUserTakeover?.(event) } catch { /* Consumer callbacks cannot resume control. */ }
  }
}
