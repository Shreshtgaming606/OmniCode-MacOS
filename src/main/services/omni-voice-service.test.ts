import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import {
  MacOSSayTextToSpeechProvider,
  MacOSSpeechToTextProvider,
  NodeVoiceProcessRunner,
  OmniVoiceService,
  resolveOmniSpeechHelperPath,
  type SpeechRecognitionSession,
  type SpeechToTextProvider,
  type VoiceProcessHandle,
  type VoiceProcessResult,
  type VoiceProcessRunner
} from './omni-voice-service'

class FakeHandle implements VoiceProcessHandle {
  readonly completion: Promise<VoiceProcessResult>
  readonly terminate = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    queueMicrotask(() => this.finish({ exitCode: null, signal, stdout: '', stderr: '' }))
    return true
  })
  private resolve!: (result: VoiceProcessResult) => void

  constructor() {
    this.completion = new Promise((resolve) => { this.resolve = resolve })
  }

  finish(result: Partial<VoiceProcessResult> = {}): void {
    this.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', ...result })
  }
}

class FakeRunner implements VoiceProcessRunner {
  readonly starts: Array<{ executable: string; args: readonly string[]; input?: string; handle: FakeHandle }> = []

  constructor(private readonly onStart?: () => void) {}

  start(executable: string, args: readonly string[], input?: string): VoiceProcessHandle {
    const handle = new FakeHandle()
    this.starts.push({ executable, args: [...args], input, handle })
    this.onStart?.()
    return handle
  }
}

describe('MacOSSayTextToSpeechProvider', () => {
  it('reports an honest unavailable state away from macOS without starting a process', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'linux', runner })

    await expect(provider.availability()).resolves.toEqual({
      available: false,
      reason: 'Omni speech output currently requires macOS.'
    })
    await expect(provider.voices()).resolves.toEqual([])
    await expect(provider.speak('Hello')).rejects.toThrow(/requires macOS/i)
    expect(runner.starts).toHaveLength(0)
  })

  it('lists bounded installed voices by parsing only fixed say output', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })
    const voicesPromise = provider.voices()
    expect(runner.starts[0]).toMatchObject({ executable: '/usr/bin/say', args: ['-v', '?'], input: undefined })
    runner.starts[0].handle.finish({
      stdout: [
        'Alex                en_US    # Hello! My name is Alex.',
        'Bad News             en_US    # Hello! My name is Bad News.',
        'Amélie               fr_CA    # Bonjour!',
        'Eddy (English (US))  en_US    # Hello!',
        'not parseable',
        'Bad; Voice           en_US    # rejected',
        'Alex                 en_US    # duplicate'
      ].join('\n')
    })

    await expect(voicesPromise).resolves.toEqual([
      { id: 'Alex', name: 'Alex', locale: 'en_US' },
      { id: 'Bad News', name: 'Bad News', locale: 'en_US' },
      { id: 'Amélie', name: 'Amélie', locale: 'fr_CA' },
      { id: 'Eddy (English (US))', name: 'Eddy (English (US))', locale: 'en_US' }
    ])
  })

  it('does not miss cancellation triggered while a voice-list process starts', async () => {
    const controller = new AbortController()
    const runner = new FakeRunner(() => {
      controller.abort(new DOMException('Voice listing cancelled', 'AbortError'))
    })
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })

    const voices = provider.voices(controller.signal)

    expect(runner.starts[0].handle.terminate).toHaveBeenCalledWith('SIGTERM')
    await expect(voices).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('passes redacted bounded text over stdin with validated arguments and a bounded rate', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })
    const secret = 'sk-proj-1234567890abcdefgh'
    const speech = provider.speak(
      `Finished /Users/example/private.txt using api_key=${secret}. [[rate 999]] ${'a'.repeat(3_000)}`,
      { voiceId: 'Eddy (English (US))', rate: 99 }
    )
    const started = runner.starts[0]
    expect(started.executable).toBe('/usr/bin/say')
    expect(started.args).toEqual(['-v', 'Eddy (English (US))', '-r', '360', '-f', '-'])
    expect(started.input).not.toContain(secret)
    expect(started.input).not.toContain('/Users/example')
    expect(started.input).not.toContain('[[rate 999]]')
    expect(started.input!.length).toBeLessThanOrEqual(2_000)
    started.handle.finish()
    await expect(speech).resolves.toEqual({ providerId: 'macos-say', status: 'completed' })
  })

  it('rejects unsafe voice identifiers and non-finite rates before a process starts', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })

    await expect(provider.speak('Hello', { voiceId: 'Alex\n-o /tmp/output' })).rejects.toThrow(/valid installed macOS voice/i)
    await expect(provider.speak('Hello', { rate: Number.NaN })).rejects.toThrow(/valid speaking rate/i)
    expect(runner.starts).toHaveLength(0)
  })

  it('maps the provider-neutral minimum rate to safe macOS words per minute', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })
    const speech = provider.speak('Hello', { rate: -10 })
    expect(runner.starts[0].args).toEqual(['-r', '90', '-f', '-'])
    runner.starts[0].handle.finish()
    await speech
  })

  it('allows only one active utterance by interrupting the previous child', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })
    const first = provider.speak('First response')
    const firstHandle = runner.starts[0].handle
    const second = provider.speak('Second response')
    expect(firstHandle.terminate).toHaveBeenCalledWith('SIGTERM')
    expect(runner.starts).toHaveLength(2)

    await expect(first).resolves.toEqual({ providerId: 'macos-say', status: 'interrupted' })
    runner.starts[1].handle.finish()
    await expect(second).resolves.toEqual({ providerId: 'macos-say', status: 'completed' })
  })

  it('stops the current child and resolves its utterance as interrupted', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })
    const speech = provider.speak('A longer response')

    await expect(provider.stop()).resolves.toBe(true)
    expect(runner.starts[0].handle.terminate).toHaveBeenCalledWith('SIGTERM')
    await expect(speech).resolves.toEqual({ providerId: 'macos-say', status: 'interrupted' })
    await expect(provider.stop()).resolves.toBe(false)
  })

  it('honors AbortSignal before and during speech', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })
    const alreadyAborted = new AbortController()
    alreadyAborted.abort(new DOMException('No speech', 'AbortError'))
    await expect(provider.speak('Never starts', { signal: alreadyAborted.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(runner.starts).toHaveLength(0)

    const controller = new AbortController()
    const speech = provider.speak('Starts and stops', { signal: controller.signal })
    controller.abort(new DOMException('Interrupted by the user', 'AbortError'))
    expect(runner.starts[0].handle.terminate).toHaveBeenCalledWith('SIGTERM')
    await expect(speech).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not miss cancellation triggered while a speech process starts', async () => {
    const controller = new AbortController()
    const runner = new FakeRunner(() => {
      controller.abort(new DOMException('Speech cancelled', 'AbortError'))
    })
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })

    const speech = provider.speak('Starts while cancellation arrives', { signal: controller.signal })

    expect(runner.starts[0].handle.terminate).toHaveBeenCalledWith('SIGTERM')
    await expect(speech).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('redacts process failures before surfacing them', async () => {
    const runner = new FakeRunner()
    const provider = new MacOSSayTextToSpeechProvider({ platform: 'darwin', runner })
    const speech = provider.speak('Hello')
    runner.starts[0].handle.finish({ exitCode: 1, stderr: 'api_key=super-secret-value at /Users/example/private.txt' })

    await expect(speech).rejects.toThrow(/api_key: ••••/u)
  })
})

describe('NodeVoiceProcessRunner', () => {
  it('spawns without a shell, writes speech to stdin, and returns bounded process output', async () => {
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    child.stdin = stdin
    child.stdout = stdout
    child.stderr = stderr
    child.kill = vi.fn(() => true)
    const input: Buffer[] = []
    stdin.on('data', (chunk) => input.push(Buffer.from(chunk)))
    const spawnProcess = vi.fn(() => child as ChildProcessWithoutNullStreams)
    const runner = new NodeVoiceProcessRunner(spawnProcess)

    const handle = runner.start('/usr/bin/say', ['-r', '180', '-f', '-'], 'Safe text')
    stdout.write('voice output')
    stderr.write('diagnostic')
    child.emit('close', 0, null)

    await expect(handle.completion).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: 'voice output',
      stderr: 'diagnostic'
    })
    expect(Buffer.concat(input).toString('utf8')).toBe('Safe text')
    expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/say', ['-r', '180', '-f', '-'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  })

  it('bounds combined process output and terminates the child on overflow', async () => {
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
    const stdout = new PassThrough()
    child.stdin = new PassThrough()
    child.stdout = stdout
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => true)
    const runner = new NodeVoiceProcessRunner(() => child as ChildProcessWithoutNullStreams)

    const handle = runner.start('/usr/bin/say', ['-v', '?'])
    stdout.write(Buffer.alloc(256 * 1_024 + 1, 97))

    await expect(handle.completion).rejects.toThrow(/too much output/i)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('handles child stdio errors instead of leaving an unhandled process error', async () => {
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => true)
    const runner = new NodeVoiceProcessRunner(() => child as ChildProcessWithoutNullStreams)

    const handle = runner.start('/usr/bin/say', ['-f', '-'], 'Safe text')
    child.stdin.emit('error', new Error('EPIPE'))

    await expect(handle.completion).rejects.toThrow('EPIPE')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

function fakeSpeechChild(
  onRequest: (request: Record<string, unknown>, child: ChildProcessWithoutNullStreams) => void
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
  const stdin = new PassThrough()
  child.stdin = stdin
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  let input = ''
  stdin.on('data', (chunk) => {
    input += Buffer.from(chunk).toString('utf8')
    const lines = input.split(/\r?\n/gu)
    input = lines.pop() ?? ''
    for (const line of lines) {
      if (line) onRequest(JSON.parse(line) as Record<string, unknown>, child as ChildProcessWithoutNullStreams)
    }
  })
  return child as ChildProcessWithoutNullStreams
}

describe('MacOSSpeechToTextProvider', () => {
  it('resolves development and packaged helper paths without renderer input access', () => {
    expect(resolveOmniSpeechHelperPath({ packaged: false, resourcesPath: '/resources', appPath: '/project' }))
      .toBe('/project/out/native/omnicode-speech-helper.app/Contents/MacOS/omnicode-speech-helper')
    expect(resolveOmniSpeechHelperPath({ packaged: true, resourcesPath: '/resources', appPath: '/project' }))
      .toBe('/resources/omni-native/omnicode-speech-helper.app/Contents/MacOS/omnicode-speech-helper')
  })

  it('reports an honest unavailable state away from macOS without starting the helper', async () => {
    const spawnProcess = vi.fn()
    const provider = new MacOSSpeechToTextProvider({
      platform: 'linux', helperPath: '/tmp/omnicode-speech-helper', spawnProcess,
      accessFile: vi.fn(async () => undefined)
    })

    await expect(provider.status()).resolves.toMatchObject({
      available: false,
      reason: 'Omni voice input currently requires macOS.',
      microphonePermission: 'unavailable',
      speechRecognitionPermission: 'unavailable'
    })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('parses bounded native capability and permission status', async () => {
    const spawnProcess = vi.fn(() => fakeSpeechChild((request, child) => {
      ;(child.stdout as PassThrough).write(`${JSON.stringify({
        version: 1,
        id: request.id,
        event: 'status',
        microphonePermission: 'not-determined',
        speechRecognitionPermission: 'granted',
        recognizerAvailable: true,
        onDevice: true,
        streaming: true,
        locale: 'en-US',
        supportedLocales: ['en-US', 'fr-FR'],
        inputDeviceName: 'Shresht’s AirPods',
        inputDeviceTransport: 'Bluetooth',
        sampleRate: 24_000,
        channelCount: 1
      })}\n`)
      queueMicrotask(() => child.emit('close', 0, null))
    }))
    const provider = new MacOSSpeechToTextProvider({
      platform: 'darwin', helperPath: '/tmp/omnicode-speech-helper', spawnProcess,
      accessFile: vi.fn(async () => undefined)
    })

    await expect(provider.status('en_US')).resolves.toEqual({
      available: true,
      providerId: 'macos-speech',
      microphonePermission: 'not-determined',
      speechRecognitionPermission: 'granted',
      onDevice: true,
      streaming: true,
      locale: 'en-US',
      supportedLocales: ['en-US', 'fr-FR'],
      inputDeviceName: 'Shresht’s AirPods',
      inputDeviceTransport: 'Bluetooth',
      sampleRate: 24_000,
      channelCount: 1
    })
  })

  it('requests speech authorization independently of recognizer availability', async () => {
    const spawnProcess = vi.fn(() => fakeSpeechChild((request, child) => {
      ;(child.stdout as PassThrough).write(`${JSON.stringify({
        version: 1, id: request.id, event: 'permission', permission: 'speech-recognition', state: 'granted'
      })}\n`)
      queueMicrotask(() => child.emit('close', 0, null))
    }))
    const provider = new MacOSSpeechToTextProvider({
      platform: 'darwin', helperPath: '/tmp/omnicode-speech-helper', spawnProcess,
      accessFile: vi.fn(async () => undefined)
    })

    await expect(provider.requestPermission('speech-recognition')).resolves.toBe('granted')
    expect(spawnProcess).toHaveBeenCalledOnce()
  })

  it('streams transcript text and finalizes only after an explicit stop response', async () => {
    const partials: string[] = []
    const amplitudes: number[] = []
    const states: string[] = []
    const diagnostics: unknown[] = []
    let recognizeRequest: Record<string, unknown> | undefined
    const spawnProcess = vi.fn(() => fakeSpeechChild((request, child) => {
      if (request.command === 'recognize') {
        recognizeRequest = request
        // AVAudioEngine can deliver its first buffer before the main thread
        // emits `ready`, especially while a Bluetooth route is warming up.
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'amplitude', amplitude: 0.17 })}\n`)
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'partial', transcript: 'open' })}\n`)
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'ready', locale: 'en-US', onDevice: true })}\n`)
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'state', state: 'LISTENING' })}\n`)
        ;(child.stdout as PassThrough).write(`${JSON.stringify({
          version: 1, id: request.id, event: 'diagnostic', inputDeviceName: 'Shresht’s AirPods',
          inputDeviceTransport: 'Bluetooth', sampleRate: 24_000, channelCount: 1, locale: 'en-US',
          onDeviceRequested: true, onDeviceSupported: true, onDeviceActive: true, partialResultCount: 0
        })}\n`)
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'amplitude', amplitude: 0.42 })}\n`)
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'partial', transcript: 'open spot if I' })}\n`)
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'partial', transcript: 'open Spotify' })}\n`)
      } else if (request.command === 'stop') {
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'final', transcript: 'Hello OmniCode', cancelled: false, reason: 'ENTER' })}\n`)
        queueMicrotask(() => child.emit('close', 0, null))
      }
    }))
    const provider = new MacOSSpeechToTextProvider({
      platform: 'darwin', helperPath: '/tmp/omnicode-speech-helper', spawnProcess,
      accessFile: vi.fn(async () => undefined)
    })

    const session = await provider.start({
      requireOnDevice: true,
      finishSpeaking: 'enter',
      endOfSpeechDelayMs: 2_000,
      onPartial: (text) => partials.push(text),
      onAmplitude: (amplitude) => amplitudes.push(amplitude),
      onState: (state) => states.push(state),
      onDiagnostic: (detail) => diagnostics.push(detail)
    })
    expect(partials).toEqual(['open', 'open spot if I', 'open Spotify'])
    expect(amplitudes).toEqual([0.17, 0.42])
    expect(states).toEqual(['LISTENING'])
    expect(diagnostics).toEqual([expect.objectContaining({
      inputDeviceName: 'Shresht’s AirPods', sampleRate: 24_000, channelCount: 1, onDeviceActive: true
    })])
    expect(recognizeRequest).toMatchObject({
      requireOnDevice: true,
      finishSpeaking: 'enter',
      initialSilenceTimeoutMs: 12_000,
      endSilenceMs: 2_000,
      maximumDurationMs: 300_000
    })
    await expect(session.stop('ENTER')).resolves.toEqual({ transcript: 'Hello OmniCode', cancelled: false, reason: 'ENTER' })
    expect(spawnProcess).toHaveBeenCalledWith('/tmp/omnicode-speech-helper', [], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    })
  })

  it('cancels capture without submitting a transcript', async () => {
    const spawnProcess = vi.fn(() => fakeSpeechChild((request, child) => {
      if (request.command === 'recognize') {
        ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'ready' })}\n`)
      } else if (request.command === 'cancel') {
        ;(child.stdout as PassThrough).write(`${JSON.stringify({
          version: 1, id: request.id, event: 'final', transcript: '', cancelled: true, reason: 'CANCEL'
        })}\n`)
        queueMicrotask(() => child.emit('close', 0, null))
      }
    }))
    const provider = new MacOSSpeechToTextProvider({
      platform: 'darwin', helperPath: '/tmp/omnicode-speech-helper', spawnProcess,
      accessFile: vi.fn(async () => undefined)
    })

    const session = await provider.start({ requireOnDevice: true })
    await session.cancel()
    await expect(session.completion).resolves.toEqual({ transcript: '', cancelled: true, reason: 'CANCEL' })
  })

  it('surfaces a microphone route failure and does not fabricate a final result', async () => {
    const spawnProcess = vi.fn(() => fakeSpeechChild((request, child) => {
      if (request.command !== 'recognize') return
      ;(child.stdout as PassThrough).write(`${JSON.stringify({ version: 1, id: request.id, event: 'ready' })}\n`)
      queueMicrotask(() => {
        ;(child.stdout as PassThrough).write(`${JSON.stringify({
          version: 1, id: request.id, event: 'error',
          error: { code: 'microphone-disconnected', message: 'Microphone disconnected or changed. Try the voice request again.' }
        })}\n`)
        child.emit('close', 1, null)
      })
    }))
    const provider = new MacOSSpeechToTextProvider({
      platform: 'darwin', helperPath: '/tmp/omnicode-speech-helper', spawnProcess,
      accessFile: vi.fn(async () => undefined)
    })

    const session = await provider.start({ requireOnDevice: true })
    await expect(session.completion).rejects.toThrow(/microphone disconnected or changed/i)
  })
})

describe('OmniVoiceService', () => {
  it('delegates through the provider-neutral text-to-speech contract', async () => {
    const provider = {
      id: 'test-tts',
      availability: vi.fn(async () => ({ available: true })),
      voices: vi.fn(async () => [{ id: 'Test', name: 'Test', locale: 'en_US' }]),
      speak: vi.fn(async () => ({ providerId: 'test-tts', status: 'completed' as const })),
      stop: vi.fn(async () => true),
      dispose: vi.fn(async () => undefined)
    }
    const service = new OmniVoiceService(provider)

    await expect(service.availability()).resolves.toEqual({ available: true })
    await expect(service.voices()).resolves.toHaveLength(1)
    await expect(service.speak('Hello', { rate: 1.25 })).resolves.toMatchObject({ status: 'completed' })
    await expect(service.stop()).resolves.toBe(true)
    await service.dispose()
    expect(provider.speak).toHaveBeenCalledWith('Hello', { rate: 1.25 })
    expect(provider.dispose).toHaveBeenCalledOnce()
  })

  it('emits provider-neutral listening, partial, and final input events', async () => {
    let partial: ((text: string) => void) | undefined
    let amplitude: ((value: number) => void) | undefined
    let resolveCompletion!: (result: { transcript: string; cancelled: boolean; reason: 'SILENCE' }) => void
    const completion = new Promise<{ transcript: string; cancelled: boolean; reason: 'SILENCE' }>((resolve) => { resolveCompletion = resolve })
    const session: SpeechRecognitionSession = {
      id: 'voice-session',
      completion,
      stop: vi.fn(() => completion),
      cancel: vi.fn(async () => undefined)
    }
    const speechToText: SpeechToTextProvider = {
      id: 'test-stt',
      availability: vi.fn(async () => ({ available: true })),
      capabilities: vi.fn(async () => ({ onDevice: true, streaming: true, supportedLocales: ['en-US'] })),
      start: vi.fn(async (options) => {
        partial = options.onPartial
        amplitude = options.onAmplitude
        return session
      })
    }
    const textToSpeech = {
      id: 'test-tts',
      availability: vi.fn(async () => ({ available: true })),
      voices: vi.fn(async () => []),
      speak: vi.fn(async () => ({ providerId: 'test-tts', status: 'completed' as const })),
      stop: vi.fn(async () => false),
      dispose: vi.fn(async () => undefined)
    }
    const service = new OmniVoiceService(textToSpeech, speechToText)
    const events: Array<{ type: string; transcript?: string; amplitude?: number; state?: string; reason?: string }> = []
    service.onInputEvent((event) => events.push(event))

    await expect(service.startInput()).resolves.toEqual({ sessionId: 'voice-session' })
    expect(textToSpeech.stop).toHaveBeenCalledOnce()
    amplitude?.(0.6)
    partial?.('partial words')
    resolveCompletion({ transcript: 'final words', cancelled: false, reason: 'SILENCE' })
    await completion
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))

    expect(events).toEqual([
      { sessionId: 'voice-session', type: 'state', state: 'STARTING' },
      { sessionId: 'voice-session', type: 'listening', state: 'LISTENING' },
      { sessionId: 'voice-session', type: 'amplitude', amplitude: 0.6 },
      { sessionId: 'voice-session', type: 'partial', transcript: 'partial words' },
      { sessionId: 'voice-session', type: 'final', state: 'COMPLETED', reason: 'SILENCE', transcript: 'final words' }
    ])
  })

  it('forwards finish-mode settings and lets exactly one finalizer stop capture', async () => {
    let resolveCompletion!: (result: { transcript: string; cancelled: false; reason: 'ENTER' }) => void
    const completion = new Promise<{ transcript: string; cancelled: false; reason: 'ENTER' }>((resolve) => { resolveCompletion = resolve })
    const stop = vi.fn(() => completion)
    const start = vi.fn(async () => ({
      id: 'single-finalizer', completion, stop, cancel: vi.fn(async () => undefined)
    } satisfies SpeechRecognitionSession))
    const service = new OmniVoiceService({
      id: 'tts', availability: vi.fn(async () => ({ available: true })), voices: vi.fn(async () => []),
      speak: vi.fn(async () => ({ providerId: 'tts', status: 'completed' as const })),
      stop: vi.fn(async () => false), dispose: vi.fn(async () => undefined)
    }, {
      id: 'stt', availability: vi.fn(async () => ({ available: true })),
      capabilities: vi.fn(async () => ({ onDevice: true, streaming: true, supportedLocales: ['en-US'] })), start
    })
    const events: string[] = []
    service.onInputEvent((event) => { if (event.type === 'state') events.push(`${event.state}:${event.reason ?? ''}`) })

    await service.startInput({ finishSpeaking: 'enter', endOfSpeechDelayMs: 2_000 })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      requireOnDevice: true, finishSpeaking: 'enter', endOfSpeechDelayMs: 2_000
    }))
    const first = service.stopInput('single-finalizer', 'ENTER')
    const raced = service.stopInput('single-finalizer', 'SILENCE')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith('ENTER')
    expect(events.filter((event) => event.startsWith('FINALIZING_TRANSCRIPT'))).toEqual(['FINALIZING_TRANSCRIPT:ENTER'])
    resolveCompletion({ transcript: 'one request', cancelled: false, reason: 'ENTER' })
    await expect(first).resolves.toMatchObject({ transcript: 'one request', reason: 'ENTER' })
    await expect(raced).resolves.toMatchObject({ transcript: 'one request', reason: 'ENTER' })
  })

  it('emits real helper states and safe device diagnostics during a session', async () => {
    let onState: Parameters<SpeechToTextProvider['start']>[0]['onState']
    let onDiagnostic: Parameters<SpeechToTextProvider['start']>[0]['onDiagnostic']
    let resolveCompletion!: (result: { transcript: string; cancelled: false; reason: 'SILENCE' }) => void
    const completion = new Promise<{ transcript: string; cancelled: false; reason: 'SILENCE' }>((resolve) => { resolveCompletion = resolve })
    const service = new OmniVoiceService({
      id: 'tts', availability: vi.fn(async () => ({ available: true })), voices: vi.fn(async () => []),
      speak: vi.fn(async () => ({ providerId: 'tts', status: 'completed' as const })), stop: vi.fn(async () => false),
      dispose: vi.fn(async () => undefined)
    }, {
      id: 'stt', availability: vi.fn(async () => ({ available: true })),
      capabilities: vi.fn(async () => ({ onDevice: true, streaming: true, supportedLocales: ['en-US'] })),
      start: vi.fn(async (options) => {
        onState = options.onState
        onDiagnostic = options.onDiagnostic
        return { id: 'diagnostic-session', completion, stop: vi.fn(() => completion), cancel: vi.fn(async () => undefined) }
      })
    })
    const events: Array<{ type: string; state?: string; diagnostics?: unknown }> = []
    service.onInputEvent((event) => events.push(event))
    await service.startInput()
    onState?.('SPEECH_DETECTED')
    onState?.('WAITING_FOR_END')
    onDiagnostic?.({
      inputDeviceName: 'Shresht’s AirPods', inputDeviceTransport: 'Bluetooth', sampleRate: 24_000,
      channelCount: 1, locale: 'en-US', onDeviceRequested: true, onDeviceSupported: true, onDeviceActive: true,
      partialResultCount: 4
    })
    resolveCompletion({ transcript: 'done', cancelled: false, reason: 'SILENCE' })
    await completion
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'state', state: 'SPEECH_DETECTED' }),
      expect.objectContaining({ type: 'state', state: 'WAITING_FOR_END' }),
      expect.objectContaining({ type: 'diagnostic', diagnostics: expect.objectContaining({
        inputDeviceName: 'Shresht’s AirPods', onDeviceActive: true, partialResultCount: 4
      }) }),
      expect.objectContaining({ type: 'final', diagnostics: expect.objectContaining({ onDeviceActive: true }) })
    ]))
  })

  it('cancels an empty session without emitting a submit-worthy final transcript', async () => {
    let resolveCompletion!: (result: { transcript: ''; cancelled: true; reason: 'CANCEL' }) => void
    const completion = new Promise<{ transcript: ''; cancelled: true; reason: 'CANCEL' }>((resolve) => { resolveCompletion = resolve })
    const cancel = vi.fn(async () => { resolveCompletion({ transcript: '', cancelled: true, reason: 'CANCEL' }); await completion })
    const service = new OmniVoiceService(undefined, {
      id: 'stt', availability: vi.fn(async () => ({ available: true })),
      capabilities: vi.fn(async () => ({ onDevice: true, streaming: true, supportedLocales: ['en-US'] })),
      start: vi.fn(async () => ({ id: 'empty-session', completion, stop: vi.fn(() => completion), cancel }))
    })
    const events: Array<{ type: string; transcript?: string }> = []
    service.onInputEvent((event) => events.push(event))
    await service.startInput()
    await expect(service.cancelInput('empty-session')).resolves.toBe(true)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(cancel).toHaveBeenCalledOnce()
    expect(events).toContainEqual(expect.objectContaining({ type: 'cancelled' }))
    expect(events.some((event) => event.type === 'final' && Boolean(event.transcript?.trim()))).toBe(false)
  })

  it('clears startup and failed-session state so rapid consecutive sessions can be reused', async () => {
    const textToSpeech = {
      id: 'tts', availability: vi.fn(async () => ({ available: true })), voices: vi.fn(async () => []),
      speak: vi.fn(async () => ({ providerId: 'tts', status: 'completed' as const })),
      stop: vi.fn().mockRejectedValueOnce(new Error('temporary TTS stop failure')).mockResolvedValue(false),
      dispose: vi.fn(async () => undefined)
    }
    let counter = 0
    const completions: Array<(result: { transcript: string; cancelled: false; reason: 'SPEECH_FRAMEWORK' }) => void> = []
    const speechToText: SpeechToTextProvider = {
      id: 'stt', availability: vi.fn(async () => ({ available: true })),
      capabilities: vi.fn(async () => ({ onDevice: true, streaming: true, supportedLocales: ['en-US'] })),
      start: vi.fn(async () => {
        const id = `rapid-${++counter}`
        let resolve!: (result: { transcript: string; cancelled: false; reason: 'SPEECH_FRAMEWORK' }) => void
        const completion = new Promise<{ transcript: string; cancelled: false; reason: 'SPEECH_FRAMEWORK' }>((done) => { resolve = done })
        completions.push(resolve)
        return { id, completion, stop: vi.fn(() => completion), cancel: vi.fn(async () => undefined) }
      })
    }
    const service = new OmniVoiceService(textToSpeech, speechToText)
    await expect(service.startInput()).rejects.toThrow(/temporary TTS stop failure/i)

    for (let index = 0; index < 5; index += 1) {
      await expect(service.startInput()).resolves.toEqual({ sessionId: `rapid-${index + 1}` })
      completions[index]({ transcript: `request ${index + 1}`, cancelled: false, reason: 'SPEECH_FRAMEWORK' })
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
    expect(speechToText.start).toHaveBeenCalledTimes(5)
  })
})
