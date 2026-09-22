import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

import type {
  OmniPermissionState,
  OmniSpeechInputAvailability,
  OmniSpeechInputEvent,
  OmniSpeechRecognitionResult,
  OmniSpeechStartOptions
} from '../../shared/omni-contracts'

import { redactOmniActivityText } from './omni-task-store'

const SAY_EXECUTABLE = '/usr/bin/say'
const MAX_SPEECH_CHARACTERS = 2_000
const MAX_VOICE_ID_CHARACTERS = 160
const MAX_VOICES = 512
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1_024
const BASE_SPEAKING_RATE_WPM = 180
const MIN_SPEAKING_RATE = 0.5
const MAX_SPEAKING_RATE = 2
const VOICE_ID_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’()_-]*$/u
const LOCALE_PATTERN = /^[a-z]{2,3}(?:_[A-Z0-9]{2,3})?$/u
const SPEECH_HELPER_NAME = 'omnicode-speech-helper'
const DEFAULT_SPEECH_LOCALE = 'en-US'
const MAX_TRANSCRIPT_CHARACTERS = 16_384
const MAX_RECOGNITION_DURATION_MS = 60_000
const SPEECH_HELPER_TIMEOUT_MS = 15_000
const SPEECH_PERMISSION_TIMEOUT_MS = 2 * 60_000
const SPEECH_LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u

export interface VoiceProviderAvailability {
  available: boolean
  reason?: string
}

export interface InstalledVoice {
  id: string
  name: string
  locale: string
}

export interface TextToSpeechOptions {
  /** Provider-neutral multiplier. 1 is normal speed; providers map it safely. */
  rate?: number
  voiceId?: string
  signal?: AbortSignal
}

export interface TextToSpeechResult {
  providerId: string
  status: 'completed' | 'interrupted'
}

export interface TextToSpeechProvider {
  readonly id: string
  availability(): Promise<VoiceProviderAvailability>
  voices(signal?: AbortSignal): Promise<InstalledVoice[]>
  speak(text: string, options?: TextToSpeechOptions): Promise<TextToSpeechResult>
  stop(): Promise<boolean>
  dispose(): Promise<void>
}

export interface SpeechToTextProvider {
  readonly id: string
  availability(): Promise<VoiceProviderAvailability>
  capabilities(): Promise<{
    onDevice: boolean
    streaming: boolean
    supportedLocales: string[]
  }>
  start(options: {
    locale?: string
    requireOnDevice: boolean
    signal?: AbortSignal
    onPartial?(transcript: string): void
  }): Promise<SpeechRecognitionSession>
}

export interface SpeechRecognitionSession {
  readonly id: string
  readonly completion: Promise<OmniSpeechRecognitionResult>
  stop(): Promise<{ transcript: string; cancelled: boolean }>
  cancel(): Promise<void>
}

/** Contract only. OmniCode does not ship a wake-word implementation yet. */
export interface WakeWordProvider {
  readonly id: string
  availability(): Promise<VoiceProviderAvailability>
  start(options: {
    phraseId: string
    signal?: AbortSignal
    onWake(): void
  }): Promise<WakeWordSession>
}

export interface WakeWordSession {
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
}

export interface VoiceProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface VoiceProcessHandle {
  completion: Promise<VoiceProcessResult>
  terminate(signal?: NodeJS.Signals): boolean
}

export interface VoiceProcessRunner {
  start(executable: string, args: readonly string[], input?: string): VoiceProcessHandle
}

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Speech was cancelled.', 'AbortError')
}

function safeProcessError(value: string): string {
  return redactOmniActivityText(value, 320).replace(/\s+/gu, ' ').trim() || 'The macOS speech service failed.'
}

/**
 * Fixed executable process adapter used by the macOS provider. It never opens
 * a shell and bounds all captured output before it reaches application state.
 */
export class NodeVoiceProcessRunner implements VoiceProcessRunner {
  constructor(private readonly spawnProcess: SpawnProcess = spawn as SpawnProcess) {}

  start(executable: string, args: readonly string[], input?: string): VoiceProcessHandle {
    const child = this.spawnProcess(executable, [...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    let resolveCompletion!: (result: VoiceProcessResult) => void
    let rejectCompletion!: (error: Error) => void
    const completion = new Promise<VoiceProcessResult>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    const fail = (error: Error, terminate = false): void => {
      if (settled) return
      settled = true
      if (terminate) child.kill('SIGTERM')
      rejectCompletion(error)
    }
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (settled) return
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      outputBytes += Buffer.byteLength(value)
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        fail(new Error('The macOS speech service returned too much output.'), true)
        return
      }
      if (target === 'stdout') stdout += value
      else stderr += value
    }
    child.stdout.on('data', (chunk: Buffer | string) => append('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer | string) => append('stderr', chunk))
    child.once('error', fail)
    // A child that exits before consuming stdin can otherwise turn EPIPE into
    // an unhandled stream error in the main process.
    child.stdin.once('error', (error) => fail(error, true))
    child.stdout.once('error', (error) => fail(error, true))
    child.stderr.once('error', (error) => fail(error, true))
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      resolveCompletion({ exitCode, signal, stdout, stderr })
    })
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input, 'utf8')
    return {
      completion,
      terminate: (signal = 'SIGTERM') => child.kill(signal)
    }
  }
}

interface ActiveSpeech {
  generation: number
  handle: VoiceProcessHandle
  interrupted: boolean
  abortCleanup(): void
}

function assertVoiceId(value: string): string {
  const voiceId = value.trim()
  if (!voiceId || voiceId.length > MAX_VOICE_ID_CHARACTERS || !VOICE_ID_PATTERN.test(voiceId)) {
    throw new Error('Choose a valid installed macOS voice.')
  }
  return voiceId
}

function speechText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter text for Omni to speak.')
  // `say` supports inline control commands. Remove them so model text cannot
  // override the separately validated voice and rate controls.
  const withoutEmbeddedCommands = value.slice(0, MAX_SPEECH_CHARACTERS * 4).replace(/\[\[[\s\S]*?\]\]/gu, ' ')
  const redacted = redactOmniActivityText(withoutEmbeddedCommands, MAX_SPEECH_CHARACTERS)
    .replace(/\s+/gu, ' ')
    .trim()
  if (!redacted) throw new Error('The speech response was empty after safety filtering.')
  return redacted
}

function macOSRate(value: number | undefined): number {
  if (value !== undefined && !Number.isFinite(value)) throw new Error('Choose a valid speaking rate.')
  const bounded = Math.min(MAX_SPEAKING_RATE, Math.max(MIN_SPEAKING_RATE, value ?? 1))
  return Math.round(BASE_SPEAKING_RATE_WPM * bounded)
}

function parseVoices(output: string): InstalledVoice[] {
  const voices: InstalledVoice[] = []
  const seen = new Set<string>()
  for (const line of output.slice(0, MAX_PROCESS_OUTPUT_BYTES).split(/\r?\n/gu)) {
    const match = /^(.+?)\s+([a-z]{2,3}(?:_[A-Z0-9]{2,3})?)\s+#(?:\s|$)/u.exec(line)
    if (!match) continue
    const name = match[1].trim()
    const locale = match[2]
    if (!name || name.length > MAX_VOICE_ID_CHARACTERS || !VOICE_ID_PATTERN.test(name) || !LOCALE_PATTERN.test(locale)) continue
    const key = `${name}\0${locale}`
    if (seen.has(key)) continue
    seen.add(key)
    voices.push({ id: name, name, locale })
    if (voices.length >= MAX_VOICES) break
  }
  return voices
}

export interface MacOSSayProviderOptions {
  platform?: NodeJS.Platform
  runner?: VoiceProcessRunner
}

export class MacOSSayTextToSpeechProvider implements TextToSpeechProvider {
  readonly id = 'macos-say'
  readonly #platform: NodeJS.Platform
  readonly #runner: VoiceProcessRunner
  #generation = 0
  #active: ActiveSpeech | null = null

  constructor(options: MacOSSayProviderOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#runner = options.runner ?? new NodeVoiceProcessRunner()
  }

  async availability(): Promise<VoiceProviderAvailability> {
    return this.#platform === 'darwin'
      ? { available: true }
      : { available: false, reason: 'Omni speech output currently requires macOS.' }
  }

  async voices(signal?: AbortSignal): Promise<InstalledVoice[]> {
    if (this.#platform !== 'darwin') return []
    if (signal?.aborted) throw abortError(signal)
    const handle = this.#runner.start(SAY_EXECUTABLE, ['-v', '?'])
    const onAbort = (): void => { handle.terminate('SIGTERM') }
    signal?.addEventListener('abort', onAbort, { once: true })
    // A custom runner may synchronously trigger cancellation while starting.
    // AbortSignal does not replay abort events to listeners added afterward.
    if (signal?.aborted) onAbort()
    try {
      const result = await handle.completion
      if (signal?.aborted) throw abortError(signal)
      if (result.exitCode !== 0) throw new Error(safeProcessError(result.stderr))
      return parseVoices(result.stdout)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async speak(text: string, options: TextToSpeechOptions = {}): Promise<TextToSpeechResult> {
    if (this.#platform !== 'darwin') throw new Error('Omni speech output currently requires macOS.')
    if (options.signal?.aborted) throw abortError(options.signal)
    const safeText = speechText(text)
    const args: string[] = []
    if (options.voiceId !== undefined) args.push('-v', assertVoiceId(options.voiceId))
    args.push('-r', String(macOSRate(options.rate)), '-f', '-')

    this.#interruptActive()
    if (options.signal?.aborted) throw abortError(options.signal)
    const generation = ++this.#generation
    const handle = this.#runner.start(SAY_EXECUTABLE, args, safeText)
    const active: ActiveSpeech = {
      generation,
      handle,
      interrupted: false,
      abortCleanup: () => undefined
    }
    const onAbort = (): void => {
      active.interrupted = true
      handle.terminate('SIGTERM')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    active.abortCleanup = () => options.signal?.removeEventListener('abort', onAbort)
    this.#active = active
    if (options.signal?.aborted) onAbort()

    try {
      const result = await handle.completion
      if (options.signal?.aborted) throw abortError(options.signal)
      if (active.interrupted) return { providerId: this.id, status: 'interrupted' }
      if (result.exitCode !== 0) throw new Error(safeProcessError(result.stderr))
      return { providerId: this.id, status: 'completed' }
    } finally {
      active.abortCleanup()
      if (this.#active?.generation === generation) this.#active = null
    }
  }

  async stop(): Promise<boolean> {
    return this.#interruptActive()
  }

  async dispose(): Promise<void> {
    this.#interruptActive()
  }

  #interruptActive(): boolean {
    const active = this.#active
    if (!active) return false
    this.#active = null
    active.interrupted = true
    active.abortCleanup()
    active.handle.terminate('SIGTERM')
    return true
  }
}

type SpeechSpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams

type SpeechHelperEvent = Record<string, unknown> & {
  version: number
  id: string
  event: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function permissionState(value: unknown): OmniPermissionState {
  return value === 'granted' || value === 'denied' || value === 'not-determined' ||
    value === 'restricted' || value === 'unavailable' ? value : 'unavailable'
}

function speechLocale(value: unknown): string {
  const locale = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_SPEECH_LOCALE
  if (locale.length > 64 || !SPEECH_LOCALE_PATTERN.test(locale)) throw new Error('Choose a valid speech-recognition locale.')
  return locale.replaceAll('_', '-')
}

function safeSpeechHelperError(value: unknown, fallback: string): Error {
  const message = isRecord(value) && typeof value.message === 'string'
    ? safeProcessError(value.message)
    : fallback
  return new Error(message)
}

export interface ResolveOmniSpeechHelperPathOptions {
  packaged: boolean
  resourcesPath: string
  appPath: string
}

export function resolveOmniSpeechHelperPath(options: ResolveOmniSpeechHelperPathOptions): string {
  return options.packaged
    ? path.join(options.resourcesPath, 'omni-native', SPEECH_HELPER_NAME)
    : path.join(options.appPath, 'out', 'native', SPEECH_HELPER_NAME)
}

function defaultSpeechHelperPath(): string {
  let appPath = process.cwd()
  let packaged = false
  try {
    appPath = app.getAppPath()
    packaged = app.isPackaged
  } catch {
    // Unit tests can inject a path and process adapter.
  }
  return resolveOmniSpeechHelperPath({ packaged, resourcesPath: process.resourcesPath, appPath })
}

export interface MacOSSpeechToTextProviderOptions {
  platform?: NodeJS.Platform
  helperPath?: string
  spawnProcess?: SpeechSpawnProcess
  accessFile?: (filePath: string, mode?: number) => Promise<void>
  helperTimeoutMs?: number
  permissionTimeoutMs?: number
}

interface ActiveRecognition {
  id: string
  child: ChildProcessWithoutNullStreams
  completion: Promise<OmniSpeechRecognitionResult>
  stop(): Promise<OmniSpeechRecognitionResult>
  cancel(): Promise<void>
}

/**
 * Native Apple Speech adapter. The helper owns microphone frames; this process
 * receives only bounded transcript events and never persists audio.
 */
export class MacOSSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'macos-speech'
  readonly #platform: NodeJS.Platform
  readonly #helperPath: string
  readonly #spawnProcess: SpeechSpawnProcess
  readonly #accessFile: (filePath: string, mode?: number) => Promise<void>
  readonly #helperTimeoutMs: number
  readonly #permissionTimeoutMs: number

  constructor(options: MacOSSpeechToTextProviderOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#helperPath = options.helperPath ?? defaultSpeechHelperPath()
    if (!path.isAbsolute(this.#helperPath) || this.#helperPath.includes('\0')) {
      throw new Error('The Omni speech helper path must be absolute.')
    }
    this.#spawnProcess = options.spawnProcess ?? spawn as SpeechSpawnProcess
    this.#accessFile = options.accessFile ?? access
    this.#helperTimeoutMs = Math.max(1_000, Math.min(options.helperTimeoutMs ?? SPEECH_HELPER_TIMEOUT_MS, 60_000))
    this.#permissionTimeoutMs = Math.max(1_000, Math.min(options.permissionTimeoutMs ?? SPEECH_PERMISSION_TIMEOUT_MS, 5 * 60_000))
  }

  async availability(): Promise<VoiceProviderAvailability> {
    const status = await this.status().catch((error: unknown) => ({
      available: false,
      reason: safeProcessError(error instanceof Error ? error.message : ''),
      providerId: this.id,
      microphonePermission: 'unavailable' as const,
      speechRecognitionPermission: 'unavailable' as const,
      onDevice: false,
      streaming: false,
      locale: DEFAULT_SPEECH_LOCALE,
      supportedLocales: []
    }))
    return status.available ? { available: true } : { available: false, reason: status.reason }
  }

  async capabilities(): Promise<{ onDevice: boolean; streaming: boolean; supportedLocales: string[] }> {
    const status = await this.status()
    return { onDevice: status.onDevice, streaming: status.streaming, supportedLocales: status.supportedLocales }
  }

  async status(localeValue: unknown = DEFAULT_SPEECH_LOCALE): Promise<OmniSpeechInputAvailability> {
    const locale = speechLocale(localeValue)
    if (this.#platform !== 'darwin') return {
      available: false,
      providerId: this.id,
      reason: 'Omni voice input currently requires macOS.',
      microphonePermission: 'unavailable',
      speechRecognitionPermission: 'unavailable',
      onDevice: false,
      streaming: false,
      locale,
      supportedLocales: []
    }
    try { await this.#accessFile(this.#helperPath, fsConstants.X_OK) } catch {
      return {
        available: false,
        providerId: this.id,
        reason: 'The signed Omni speech helper is unavailable. Reinstall OmniCode or rebuild the native helper.',
        microphonePermission: 'unavailable',
        speechRecognitionPermission: 'unavailable',
        onDevice: false,
        streaming: false,
        locale,
        supportedLocales: []
      }
    }
    const id = randomUUID()
    const event = await this.#oneShot({ version: 1, id, command: 'status', locale }, id)
    if (event.event !== 'status') throw new Error('The speech helper returned an invalid status response.')
    const microphonePermission = permissionState(event.microphonePermission)
    const speechRecognitionPermission = permissionState(event.speechRecognitionPermission)
    const onDevice = event.onDevice === true
    const recognizerAvailable = event.recognizerAvailable === true
    const supportedLocales = Array.isArray(event.supportedLocales)
      ? event.supportedLocales.filter((item): item is string => typeof item === 'string' && item.length <= 64).slice(0, 512)
      : []
    const denied = microphonePermission === 'denied' || microphonePermission === 'restricted' ||
      speechRecognitionPermission === 'denied' || speechRecognitionPermission === 'restricted'
    const available = recognizerAvailable && onDevice && !denied
    let reason: string | undefined
    if (denied) reason = 'Microphone and Speech Recognition permissions must be allowed in System Settings.'
    else if (!recognizerAvailable) reason = 'Apple Speech Recognition is currently unavailable for this locale.'
    else if (!onDevice) reason = 'On-device Speech Recognition is unavailable for this locale.'
    return {
      available,
      providerId: this.id,
      ...(reason ? { reason } : {}),
      microphonePermission,
      speechRecognitionPermission,
      onDevice,
      streaming: event.streaming === true,
      locale: typeof event.locale === 'string' ? speechLocale(event.locale) : locale,
      supportedLocales
    }
  }

  async start(options: {
    locale?: string
    requireOnDevice: boolean
    signal?: AbortSignal
    onPartial?(transcript: string): void
  }): Promise<SpeechRecognitionSession> {
    if (this.#platform !== 'darwin') throw new Error('Omni voice input currently requires macOS.')
    if (options.requireOnDevice !== true) throw new Error('Omni voice input currently requires on-device recognition.')
    if (options.signal?.aborted) throw abortError(options.signal)
    try { await this.#accessFile(this.#helperPath, fsConstants.X_OK) } catch {
      throw new Error('The signed Omni speech helper is unavailable. Reinstall OmniCode or rebuild the native helper.')
    }
    const id = randomUUID()
    const active = await this.#startRecognition(id, speechLocale(options.locale), options)
    return {
      id,
      completion: active.completion,
      stop: () => active.stop(),
      cancel: () => active.cancel()
    }
  }

  async #oneShot(request: Record<string, unknown>, id: string): Promise<SpeechHelperEvent> {
    return await new Promise((resolve, reject) => {
      const child = this.#spawnProcess(this.#helperPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        callback()
      }
      const fail = (error: Error, terminate = false): void => {
        if (terminate) child.kill('SIGTERM')
        finish(() => reject(error))
      }
      const timeout = setTimeout(() => fail(new Error('The speech helper did not respond in time.'), true), this.#helperTimeoutMs)
      timeout.unref?.()
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        if (Buffer.byteLength(stdout) > MAX_PROCESS_OUTPUT_BYTES) fail(new Error('The speech helper returned too much data.'), true)
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        if (Buffer.byteLength(stderr) > MAX_PROCESS_OUTPUT_BYTES) fail(new Error('The speech helper returned too much diagnostic data.'), true)
      })
      child.once('error', (error) => fail(new Error(safeProcessError(error.message))))
      child.once('close', () => {
        if (settled) return
        try {
          const lines = stdout.trim().split(/\r?\n/gu).filter(Boolean)
          const parsed = lines.length === 1 ? JSON.parse(lines[0]) as unknown : null
          if (!isRecord(parsed) || parsed.version !== 1 || parsed.id !== id || typeof parsed.event !== 'string') {
            fail(new Error('The speech helper returned an invalid response.'))
            return
          }
          if (parsed.event === 'error') {
            fail(safeSpeechHelperError(parsed.error, safeProcessError(stderr)))
            return
          }
          finish(() => resolve(parsed as SpeechHelperEvent))
        } catch {
          fail(new Error('The speech helper returned an invalid response.'))
        }
      })
      child.stdin.once('error', (error) => fail(new Error(safeProcessError(error.message)), true))
      child.stdout.once('error', (error) => fail(new Error(safeProcessError(error.message)), true))
      child.stderr.once('error', (error) => fail(new Error(safeProcessError(error.message)), true))
      child.stdin.end(`${JSON.stringify(request)}\n`, 'utf8')
    })
  }

  async #startRecognition(
    id: string,
    locale: string,
    options: { signal?: AbortSignal; onPartial?(transcript: string): void }
  ): Promise<ActiveRecognition> {
    return await new Promise((resolve, reject) => {
      const child = this.#spawnProcess(this.#helperPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let ready = false
      let completionSettled = false
      let resolveCompletion!: (result: OmniSpeechRecognitionResult) => void
      let rejectCompletion!: (error: Error) => void
      const completion = new Promise<OmniSpeechRecognitionResult>((completionResolve, completionReject) => {
        resolveCompletion = completionResolve
        rejectCompletion = completionReject
      })
      // Completion can reject before the caller has received the session.
      void completion.catch(() => undefined)
      const finishCompletion = (result: OmniSpeechRecognitionResult): void => {
        if (completionSettled) return
        completionSettled = true
        resolveCompletion(result)
      }
      const failCompletion = (error: Error): void => {
        if (completionSettled) return
        completionSettled = true
        rejectCompletion(error)
      }
      const cleanup = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: Error, terminate = false): void => {
        if (terminate) child.kill('SIGTERM')
        failCompletion(error)
        if (!ready) reject(error)
        cleanup()
      }
      const sendControl = (command: 'stop' | 'cancel'): boolean => {
        if (child.stdin.destroyed || !child.stdin.writable) return false
        child.stdin.write(`${JSON.stringify({ version: 1, id, command })}\n`, 'utf8')
        return true
      }
      const session: ActiveRecognition = {
        id,
        child,
        completion,
        stop: async () => {
          if (!completionSettled && !sendControl('stop')) throw new Error('Voice recognition is no longer running.')
          return await completion
        },
        cancel: async () => {
          if (!completionSettled && !sendControl('cancel')) child.kill('SIGTERM')
          try { await completion } catch { /* Cancellation is best-effort during teardown. */ }
        }
      }
      const onAbort = (): void => {
        sendControl('cancel')
        const error = abortError(options.signal)
        fail(error instanceof Error ? error : new Error('Voice recognition was cancelled.'), false)
      }
      const timeout = setTimeout(() => fail(new Error('Voice recognition permission or startup timed out.'), true), this.#permissionTimeoutMs)
      timeout.unref?.()

      const handleLine = (line: string): void => {
        if (!line.trim()) return
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch {
          fail(new Error('The speech helper returned an invalid event.'), true)
          return
        }
        if (!isRecord(parsed) || parsed.version !== 1 || parsed.id !== id || typeof parsed.event !== 'string') {
          fail(new Error('The speech helper returned an unverifiable event.'), true)
          return
        }
        if (parsed.event === 'ready') {
          if (ready) return
          ready = true
          clearTimeout(timeout)
          resolve(session)
          return
        }
        if (parsed.event === 'partial') {
          if (!ready || typeof parsed.transcript !== 'string' || parsed.transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
            fail(new Error('The speech helper returned an invalid partial transcript.'), true)
            return
          }
          options.onPartial?.(parsed.transcript)
          return
        }
        if (parsed.event === 'final') {
          if (!ready || typeof parsed.transcript !== 'string' || parsed.transcript.length > MAX_TRANSCRIPT_CHARACTERS || typeof parsed.cancelled !== 'boolean') {
            fail(new Error('The speech helper returned an invalid final transcript.'), true)
            return
          }
          finishCompletion({ transcript: parsed.transcript, cancelled: parsed.cancelled })
          cleanup()
          return
        }
        if (parsed.event === 'error') {
          fail(safeSpeechHelperError(parsed.error, 'Voice recognition failed.'))
          return
        }
        fail(new Error('The speech helper returned an unsupported event.'), true)
      }

      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        stdoutBytes += Buffer.byteLength(value)
        stdout += value
        if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
          fail(new Error('The speech helper returned too much transcript data.'), true)
          return
        }
        const lines = stdout.split(/\r?\n/gu)
        stdout = lines.pop() ?? ''
        for (const line of lines) handleLine(line)
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) fail(new Error('The speech helper returned too much diagnostic data.'), true)
      })
      child.once('error', (error) => fail(new Error(safeProcessError(error.message))))
      child.once('close', () => {
        if (!completionSettled) fail(new Error('Voice recognition ended before returning a final transcript.'))
      })
      child.stdin.once('error', (error) => fail(new Error(safeProcessError(error.message)), true))
      child.stdout.once('error', (error) => fail(new Error(safeProcessError(error.message)), true))
      child.stderr.once('error', (error) => fail(new Error(safeProcessError(error.message)), true))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      child.stdin.write(`${JSON.stringify({
        version: 1,
        id,
        command: 'recognize',
        locale,
        requireOnDevice: true,
        maximumDurationMs: MAX_RECOGNITION_DURATION_MS,
        maximumTranscriptCharacters: MAX_TRANSCRIPT_CHARACTERS
      })}\n`, 'utf8')
    })
  }
}

export class OmniVoiceService {
  readonly #listeners = new Set<(event: OmniSpeechInputEvent) => void>()
  #activeInput: SpeechRecognitionSession | null = null

  constructor(
    readonly textToSpeech: TextToSpeechProvider = new MacOSSayTextToSpeechProvider(),
    readonly speechToText: SpeechToTextProvider = new MacOSSpeechToTextProvider()
  ) {}

  availability(): Promise<VoiceProviderAvailability> {
    return this.textToSpeech.availability()
  }

  voices(signal?: AbortSignal): Promise<InstalledVoice[]> {
    return this.textToSpeech.voices(signal)
  }

  speak(text: string, options?: TextToSpeechOptions): Promise<TextToSpeechResult> {
    return this.textToSpeech.speak(text, options)
  }

  stop(): Promise<boolean> {
    return this.textToSpeech.stop()
  }

  inputAvailability(locale?: string): Promise<OmniSpeechInputAvailability> {
    if (this.speechToText instanceof MacOSSpeechToTextProvider) return this.speechToText.status(locale)
    return Promise.all([this.speechToText.availability(), this.speechToText.capabilities()]).then(([availability, capabilities]) => ({
      available: availability.available,
      providerId: this.speechToText.id,
      ...(availability.reason ? { reason: availability.reason } : {}),
      microphonePermission: availability.available ? 'granted' : 'unavailable',
      speechRecognitionPermission: availability.available ? 'granted' : 'unavailable',
      onDevice: capabilities.onDevice,
      streaming: capabilities.streaming,
      locale: speechLocale(locale),
      supportedLocales: capabilities.supportedLocales
    }))
  }

  async startInput(options: OmniSpeechStartOptions = {}): Promise<{ sessionId: string }> {
    if (this.#activeInput) throw new Error('Omni is already listening for a voice request.')
    if (options.requireOnDevice !== undefined && options.requireOnDevice !== true) {
      throw new Error('Omni voice input requires on-device recognition.')
    }
    await this.textToSpeech.stop()
    let sessionId = ''
    let pendingPartial = ''
    const session = await this.speechToText.start({
      locale: speechLocale(options.locale),
      requireOnDevice: true,
      onPartial: (transcript) => {
        if (!sessionId) pendingPartial = transcript
        else this.#emit({ sessionId, type: 'partial', transcript })
      }
    })
    sessionId = session.id
    this.#activeInput = session
    this.#emit({ sessionId: session.id, type: 'listening' })
    if (pendingPartial) this.#emit({ sessionId: session.id, type: 'partial', transcript: pendingPartial })
    void session.completion.then((result) => {
      if (this.#activeInput?.id === session.id) this.#activeInput = null
      this.#emit({
        sessionId: session.id,
        type: result.cancelled ? 'cancelled' : 'final',
        ...(result.transcript ? { transcript: result.transcript } : {})
      })
    }).catch((error: unknown) => {
      if (this.#activeInput?.id === session.id) this.#activeInput = null
      this.#emit({ sessionId: session.id, type: 'error', error: safeProcessError(error instanceof Error ? error.message : '') })
    })
    return { sessionId: session.id }
  }

  async stopInput(sessionId: string): Promise<OmniSpeechRecognitionResult> {
    const session = this.#requireInputSession(sessionId)
    return await session.stop()
  }

  async cancelInput(sessionId: string): Promise<boolean> {
    const session = this.#activeInput
    if (!session || session.id !== sessionId) return false
    this.#activeInput = null
    await session.cancel()
    return true
  }

  onInputEvent(listener: (event: OmniSpeechInputEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    const input = this.#activeInput
    this.#activeInput = null
    if (input) await input.cancel().catch(() => undefined)
    await this.textToSpeech.dispose()
  }

  #requireInputSession(sessionId: string): SpeechRecognitionSession {
    if (!sessionId || sessionId.length > 128) throw new Error('Choose a valid voice-input session.')
    const session = this.#activeInput
    if (!session || session.id !== sessionId) throw new Error('That voice-input session is no longer active.')
    return session
  }

  #emit(event: OmniSpeechInputEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event) } catch { /* A UI listener cannot break microphone cleanup. */ }
    }
  }
}
