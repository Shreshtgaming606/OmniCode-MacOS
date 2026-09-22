import { chmod, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('The Omni speech helper can only be built on macOS.')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(projectRoot, 'native', 'omni-speech-helper', 'main.swift')
const entitlements = path.join(projectRoot, 'build', 'entitlements.omni-speech.plist')
const outputDirectory = path.join(projectRoot, 'out', 'native')
const output = path.join(outputDirectory, 'omnicode-speech-helper')
const requestedArchitecture = process.env.npm_config_arch || process.env.OMNICODE_TARGET_ARCH || process.arch
const targetArchitecture = requestedArchitecture === 'x64' ? 'x86_64' : requestedArchitecture === 'arm64' ? 'arm64' : null
if (!targetArchitecture) throw new Error(`Unsupported Omni speech helper architecture: ${requestedArchitecture}`)

await mkdir(outputDirectory, { recursive: true })
const compilation = spawnSync('xcrun', [
  'swiftc', '-target', `${targetArchitecture}-apple-macos14.0`, source, '-o', output,
  '-framework', 'AVFoundation', '-framework', 'Speech'
], {
  cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60_000, windowsHide: true
})
if (compilation.error) throw compilation.error
if (compilation.status !== 0) {
  const diagnostic = String(compilation.stderr || compilation.stdout || 'Swift compiler failed.').trim().slice(0, 8_000)
  throw new Error(`Could not build the Omni speech helper for ${targetArchitecture}:\n${diagnostic}`)
}

await chmod(output, 0o755)
const signing = spawnSync('/usr/bin/codesign', [
  '--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', '--entitlements', entitlements, output
], {
  cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true
})
if (signing.error) throw signing.error
if (signing.status !== 0) {
  const diagnostic = String(signing.stderr || signing.stdout || 'codesign failed.').trim().slice(0, 8_000)
  throw new Error(`Could not ad-hoc sign the Omni speech helper for ${targetArchitecture}:\n${diagnostic}`)
}

console.log(`Built and ad-hoc signed Omni speech helper for ${targetArchitecture}.`)
