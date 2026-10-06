import type { OmniVoiceFinalizationReason, OmniVoiceSessionState } from '../../shared/omni-contracts'

const TERMINAL = new Set<OmniVoiceSessionState>(['COMPLETED', 'CANCELLED', 'FAILED'])

const ALLOWED: Record<OmniVoiceSessionState, ReadonlySet<OmniVoiceSessionState>> = {
  IDLE: new Set(['STARTING']),
  STARTING: new Set(['LISTENING', 'CANCELLED', 'FAILED']),
  LISTENING: new Set(['SPEECH_DETECTED', 'FINALIZING_TRANSCRIPT', 'CANCELLED', 'FAILED']),
  SPEECH_DETECTED: new Set(['WAITING_FOR_END', 'FINALIZING_TRANSCRIPT', 'CANCELLED', 'FAILED']),
  WAITING_FOR_END: new Set(['SPEECH_DETECTED', 'FINALIZING_TRANSCRIPT', 'CANCELLED', 'FAILED']),
  FINALIZING_TRANSCRIPT: new Set(['THINKING', 'COMPLETED', 'CANCELLED', 'FAILED']),
  THINKING: new Set(['WORKING', 'SPEAKING', 'COMPLETED', 'CANCELLED', 'FAILED']),
  WORKING: new Set(['SPEAKING', 'COMPLETED', 'CANCELLED', 'FAILED']),
  SPEAKING: new Set(['COMPLETED', 'CANCELLED', 'FAILED']),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
  FAILED: new Set()
}

/**
 * Deterministic lifecycle guard for one spoken request. Audio timing remains in
 * the native helper, but every completion signal must win this single guard
 * before it may finalize or submit the utterance.
 */
export class OmniVoiceSessionMachine {
  #state: OmniVoiceSessionState = 'IDLE'
  #finalizationReason: OmniVoiceFinalizationReason | undefined

  get state(): OmniVoiceSessionState { return this.#state }
  get finalizationReason(): OmniVoiceFinalizationReason | undefined { return this.#finalizationReason }
  get terminal(): boolean { return TERMINAL.has(this.#state) }

  start(): boolean { return this.transition('STARTING') }

  transition(next: OmniVoiceSessionState): boolean {
    if (next === this.#state) return false
    if (!ALLOWED[this.#state].has(next)) return false
    this.#state = next
    return true
  }

  finalizeOnce(reason: OmniVoiceFinalizationReason): boolean {
    if (this.#state === 'FINALIZING_TRANSCRIPT' || this.terminal ||
        !['LISTENING', 'SPEECH_DETECTED', 'WAITING_FOR_END'].includes(this.#state)) return false
    this.#finalizationReason = reason
    this.#state = 'FINALIZING_TRANSCRIPT'
    return true
  }

  complete(): boolean { return this.transition('COMPLETED') }
  cancel(): boolean {
    if (this.terminal) return false
    this.#finalizationReason = 'CANCEL'
    this.#state = 'CANCELLED'
    return true
  }
  fail(): boolean {
    if (this.terminal) return false
    this.#state = 'FAILED'
    return true
  }
}
