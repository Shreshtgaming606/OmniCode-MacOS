import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Omni speech helper build configuration', () => {
  it('builds a signed helper app with a stable privacy identity', () => {
    const root = process.cwd()
    const plist = readFileSync(path.join(root, 'build', 'omni-speech-helper.Info.plist'), 'utf8')
    const script = readFileSync(path.join(root, 'scripts', 'build-omni-speech-helper.mjs'), 'utf8')

    expect(plist).toContain('<string>com.omnicode.editor.speech-helper</string>')
    expect(plist).toContain('<key>NSMicrophoneUsageDescription</key>')
    expect(plist).toContain('<key>NSSpeechRecognitionUsageDescription</key>')
    expect(plist).toMatch(/on-device macOS Speech Recognition/u)
    expect(plist).toContain('<key>CFBundlePackageType</key>')
    expect(plist).toContain('<string>APPL</string>')
    expect(script).toContain("'omnicode-speech-helper.app'")
    expect(script).toContain('await copyFile(infoPlist, outputInfoPlist)')
    expect(script).toContain("'/usr/bin/plutil', ['-lint', infoPlist]")
    expect(script).toContain("'--options', 'runtime'")
  })
})
