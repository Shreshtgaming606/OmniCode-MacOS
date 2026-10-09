import type { MacOSPlatformSnapshot, MacOSReleaseProfile } from '../../shared/platform-contracts'

declare const __OMNICODE_RELEASE_PROFILE__: MacOSReleaseProfile

export function resolvePlatformCapabilities(
  release: MacOSReleaseProfile,
  actualMacOS: string,
  architecture: string
): MacOSPlatformSnapshot {
  const major = Number.parseInt(actualMacOS.split('.')[0] ?? '', 10)
  const modern = release === 'current' && Number.isFinite(major) && major >= 15
  return {
    release,
    label: release === 'current' ? 'Current' : 'Sonoma Legacy',
    minimumMacOS: release === 'current' ? '15.0' : '14.0',
    actualMacOS,
    architecture,
    capabilities: {
      nativeTranslation: modern,
      nativeVisionOCR: modern,
      windowCapture: modern,
      // Apple's macOS 15 HDR capture API is Apple Silicon-only in practice.
      windowCaptureHDR: modern && architecture === 'arm64',
      spotlightIndex: Number.isFinite(major) && major >= 14,
      semanticSpotlightSearch: modern
    }
  }
}

export function packagedReleaseProfile(): MacOSReleaseProfile {
  return typeof __OMNICODE_RELEASE_PROFILE__ !== 'undefined' && __OMNICODE_RELEASE_PROFILE__ === 'legacy'
    ? 'legacy' : 'current'
}
