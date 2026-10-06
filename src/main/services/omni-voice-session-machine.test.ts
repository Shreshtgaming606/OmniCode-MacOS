import { describe, expect, it } from 'vitest'

import { OmniVoiceSessionMachine } from './omni-voice-session-machine'

describe('OmniVoiceSessionMachine', () => {
  it('enforces deterministic capture transitions', () => {
    const machine = new OmniVoiceSessionMachine()
    expect(machine.state).toBe('IDLE')
    expect(machine.start()).toBe(true)
    expect(machine.transition('LISTENING')).toBe(true)
    expect(machine.transition('SPEECH_DETECTED')).toBe(true)
    expect(machine.transition('WAITING_FOR_END')).toBe(true)
    expect(machine.transition('SPEECH_DETECTED')).toBe(true)
    expect(machine.finalizeOnce('SILENCE')).toBe(true)
    expect(machine.complete()).toBe(true)
    expect(machine.state).toBe('COMPLETED')
  })

  it.each(['ENTER', 'SILENCE', 'TIMEOUT', 'SPEECH_FRAMEWORK'] as const)(
    'allows only one finalizer when %s wins the race',
    (winner) => {
      const machine = new OmniVoiceSessionMachine()
      machine.start(); machine.transition('LISTENING'); machine.transition('SPEECH_DETECTED')
      expect(machine.finalizeOnce(winner)).toBe(true)
      expect(machine.finalizeOnce('ENTER')).toBe(false)
      expect(machine.finalizeOnce('SILENCE')).toBe(false)
      expect(machine.finalizationReason).toBe(winner)
    }
  )

  it('cancels without entering finalization and rejects later completion signals', () => {
    const machine = new OmniVoiceSessionMachine()
    machine.start(); machine.transition('LISTENING')
    expect(machine.cancel()).toBe(true)
    expect(machine.state).toBe('CANCELLED')
    expect(machine.finalizeOnce('ENTER')).toBe(false)
    expect(machine.complete()).toBe(false)
  })

  it('supports interaction states after transcript finalization', () => {
    const machine = new OmniVoiceSessionMachine()
    machine.start(); machine.transition('LISTENING'); machine.transition('SPEECH_DETECTED')
    machine.finalizeOnce('ENTER')
    expect(machine.transition('THINKING')).toBe(true)
    expect(machine.transition('WORKING')).toBe(true)
    expect(machine.transition('SPEAKING')).toBe(true)
    expect(machine.complete()).toBe(true)
  })

  it('fails closed from startup and remains terminal', () => {
    const machine = new OmniVoiceSessionMachine()
    machine.start()
    expect(machine.fail()).toBe(true)
    expect(machine.state).toBe('FAILED')
    expect(machine.transition('LISTENING')).toBe(false)
  })
})
