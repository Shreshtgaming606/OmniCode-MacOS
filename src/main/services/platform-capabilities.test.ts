import { describe, expect, it } from 'vitest'
import { resolvePlatformCapabilities } from './platform-capabilities'

describe('macOS release capability matrix', () => {
  it('enables macOS 15 capabilities only in the Current profile', () => {
    expect(resolvePlatformCapabilities('current', '15.7', 'arm64').capabilities).toEqual({
      nativeTranslation: true, nativeVisionOCR: true, windowCapture: true, windowCaptureHDR: true,
      spotlightIndex: true, semanticSpotlightSearch: true
    })
    expect(resolvePlatformCapabilities('legacy', '27.0', 'arm64').capabilities).toEqual({
      nativeTranslation: false, nativeVisionOCR: false, windowCapture: false, windowCaptureHDR: false,
      spotlightIndex: true, semanticSpotlightSearch: false
    })
  })

  it('keeps Intel HDR capture disabled and reports exact release metadata', () => {
    expect(resolvePlatformCapabilities('current', '27.0', 'x64')).toMatchObject({
      label: 'Current', minimumMacOS: '15.0',
      capabilities: { nativeTranslation: true, nativeVisionOCR: true, windowCapture: true, windowCaptureHDR: false, spotlightIndex: true, semanticSpotlightSearch: true }
    })
    expect(resolvePlatformCapabilities('legacy', '14.7', 'x64')).toMatchObject({
      label: 'Sonoma Legacy', minimumMacOS: '14.0'
    })
  })

  it('fails closed on an unknown OS version', () => {
    expect(resolvePlatformCapabilities('current', 'unknown', 'arm64').capabilities.nativeTranslation).toBe(false)
    expect(resolvePlatformCapabilities('current', 'unknown', 'arm64').capabilities.spotlightIndex).toBe(false)
  })
})
