import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OmniCursorObservation } from '../../shared/omni-cursor-contracts'
import {
  OmniCursorNativeError,
  OmniCursorService,
  resolveOmniCursorHelperPath,
  type OmniCursorNativeAdapter,
  type OmniCursorNativeCommand
} from './omni-cursor-service'

function observation(x = 10, y = 20): OmniCursorObservation {
  return {
    cursor: { x, y },
    frontmostApplication: { name: 'Finder', bundleIdentifier: 'com.apple.finder', processIdentifier: 123 },
    frontmostWindow: { x: 100, y: 80, width: 900, height: 700 },
    observedAt: 1_000
  }
}

function adapter(execute: (command: OmniCursorNativeCommand) => Promise<unknown>): OmniCursorNativeAdapter {
  return { available: vi.fn(async () => true), execute: vi.fn(execute) }
}

afterEach(() => vi.useRealTimers())

describe('OmniCursorService', () => {
  it('reports helper and Accessibility state without requesting permission', async () => {
    const native = adapter(async () => observation())
    await expect(new OmniCursorService({
      platform: 'darwin', accessibilityTrusted: () => true, adapter: native, now: () => 42
    }).permissions()).resolves.toEqual({ accessibility: 'granted', nativeHelper: 'available', checkedAt: 42 })

    await expect(new OmniCursorService({
      platform: 'linux', accessibilityTrusted: () => true, adapter: native, now: () => 43
    }).permissions()).resolves.toEqual({ accessibility: 'unavailable', nativeHelper: 'unavailable', checkedAt: 43 })
  })

  it('fails closed before invoking native control when Accessibility is missing', async () => {
    const native = adapter(async () => observation())
    const service = new OmniCursorService({ platform: 'darwin', accessibilityTrusted: () => false, adapter: native })

    await expect(service.move({ x: 100, y: 100 })).rejects.toMatchObject({ code: 'accessibility-denied' })
    expect(native.execute).not.toHaveBeenCalled()
  })

  it('sends only validated structured commands to the native adapter', async () => {
    const native = adapter(async (command) => command.command === 'observe'
      ? observation()
      : { observation: observation(40, 60) })
    const service = new OmniCursorService({ platform: 'darwin', accessibilityTrusted: () => true, adapter: native })

    await expect(service.move({ x: 40, y: 60, durationMs: 250 })).resolves.toEqual({ observation: observation(40, 60) })
    await service.pressKey({ key: 'K', modifiers: ['shift', 'command', 'command'], repeat: 2 })
    await service.focusApplication('finder')

    expect(native.execute).toHaveBeenNthCalledWith(1, { command: 'move', x: 40, y: 60, durationMs: 250 }, undefined)
    expect(native.execute).toHaveBeenNthCalledWith(2, {
      command: 'press-key', key: 'k', modifiers: ['command', 'shift'], repeat: 2
    }, undefined)
    expect(native.execute).toHaveBeenNthCalledWith(3, {
      command: 'focus-application', bundleIdentifier: 'com.apple.finder'
    }, undefined)
  })

  it('rejects coordinates, keys, text, applications, and malformed native responses outside the contract', async () => {
    const native = adapter(async () => ({ observation: { cursor: { x: Number.NaN, y: 0 } } }))
    const service = new OmniCursorService({ platform: 'darwin', accessibilityTrusted: () => true, adapter: native })

    await expect(service.move({ x: 200_000, y: 0 })).rejects.toThrow(/supported range/i)
    await expect(service.pressKey({ key: 'volume-up' })).rejects.toThrow(/allowlisted/i)
    await expect(service.typeText('x'.repeat(8_193))).rejects.toThrow(/8,192/i)
    await expect(service.focusApplication('calculator' as 'finder')).rejects.toThrow(/allowlisted/i)
    await expect(service.click()).rejects.toThrow(/cursor helper|coordinate|observation/i)
  })

  it('rejects invalid native window geometry', async () => {
    const native = adapter(async () => ({
      ...observation(),
      frontmostWindow: { x: 0, y: 0, width: 0, height: 500 }
    }))
    const service = new OmniCursorService({ platform: 'darwin', accessibilityTrusted: () => true, adapter: native })

    await expect(service.observe()).rejects.toThrow(/window geometry/i)
  })

  it('pauses a session when the user moves the pointer between actions', async () => {
    vi.useFakeTimers()
    const execute = vi.fn()
      .mockResolvedValueOnce(observation(0, 0))
      .mockResolvedValueOnce(observation(30, 0))
    const native: OmniCursorNativeAdapter = { available: vi.fn(async () => true), execute }
    const takeover = vi.fn()
    const service = new OmniCursorService({ platform: 'darwin', accessibilityTrusted: () => true, adapter: native })
    const session = await service.startSession({ takeoverPollIntervalMs: 50, takeoverTolerancePixels: 12, onUserTakeover: takeover })

    await vi.advanceTimersByTimeAsync(60)

    expect(session.state).toBe('user-takeover')
    expect(takeover).toHaveBeenCalledWith(expect.objectContaining({ reason: 'pointer-moved', currentCursor: { x: 30, y: 0 } }))
    await expect(session.click()).rejects.toThrow(/paused because you took control/i)
    session.dispose()
  })

  it('uses different trusted helper paths in development and packaged applications', () => {
    expect(resolveOmniCursorHelperPath({ packaged: false, resourcesPath: '/Applications/unused', appPath: '/project' }))
      .toBe('/project/out/native/omnicode-cursor-helper')
    expect(resolveOmniCursorHelperPath({ packaged: true, resourcesPath: '/Applications/OmniCode.app/Contents/Resources', appPath: '/unused' }))
      .toBe('/Applications/OmniCode.app/Contents/Resources/omni-native/omnicode-cursor-helper')
  })

  it('keeps native error codes explicit for controller-level pause handling', () => {
    expect(new OmniCursorNativeError('user-takeover', 'Paused').code).toBe('user-takeover')
  })
})
