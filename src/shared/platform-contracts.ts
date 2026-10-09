export type MacOSReleaseProfile = 'current' | 'legacy'
export type ModernMacOSCapability = 'nativeTranslation' | 'nativeVisionOCR' | 'windowCapture' | 'windowCaptureHDR' | 'spotlightIndex' | 'semanticSpotlightSearch'

export interface MacOSPlatformSnapshot {
  release: MacOSReleaseProfile
  label: 'Current' | 'Sonoma Legacy'
  minimumMacOS: '15.0' | '14.0'
  actualMacOS: string
  architecture: string
  capabilities: Record<ModernMacOSCapability, boolean>
}
