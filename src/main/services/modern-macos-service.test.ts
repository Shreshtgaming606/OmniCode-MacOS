import { describe, expect, it } from 'vitest'
import { assertNativeFeatureAllowed, nativeFeatureHelperPath } from './modern-macos-service'
import { resolvePlatformCapabilities } from './platform-capabilities'

describe('modern macOS native bridge', () => {
  it('never runs Current-only operations from a Sonoma Legacy package', () => {
    const legacy = resolvePlatformCapabilities('legacy', '27.0', 'arm64')
    for (const operation of ['translate', 'recognize-text', 'capture-window'] as const) {
      expect(() => assertNativeFeatureAllowed(legacy, operation)).toThrow(/Current OmniCode/)
    }
  })

  it('constructs development and packaged helper locations deterministically', () => {
    expect(nativeFeatureHelperPath(false, '/repo', '/resources')).toContain('/repo/out/native/omnicode-modern-helper.app/')
    expect(nativeFeatureHelperPath(true, '/repo', '/resources')).toContain('/resources/omni-native/omnicode-modern-helper.app/')
  })
})
