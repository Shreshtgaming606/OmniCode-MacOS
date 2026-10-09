export const RELEASE_PROFILES = Object.freeze({
  current: Object.freeze({ id: 'current', minimumMacOS: '15.0', label: 'Current', filenameSegment: 'macOS15' }),
  legacy: Object.freeze({ id: 'legacy', minimumMacOS: '14.0', label: 'Sonoma Legacy', filenameSegment: 'Sonoma-Legacy' })
})

export function releaseProfile(value = 'current') {
  const profile = RELEASE_PROFILES[value]
  if (!profile) throw new Error(`Unknown macOS release profile: ${value}`)
  return profile
}

export function releaseArtifactName(version, profile, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unknown macOS architecture: ${arch}`)
  return `OmniCode-${version}-${profile.filenameSegment}-${arch}.dmg`
}
