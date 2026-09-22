import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'

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

/** Contract only. OmniCode does not ship an STT implementation yet. */
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

export class OmniVoiceService {
  constructor(readonly textToSpeech: TextToSpeechProvider = new MacOSSayTextToSpeechProvider()) {}

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

  dispose(): Promise<void> {
    return this.textToSpeech.dispose()
  }
}
