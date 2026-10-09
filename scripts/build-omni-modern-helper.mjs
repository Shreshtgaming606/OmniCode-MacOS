import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { releaseProfile } from './macos-release-profile.mjs'

if (process.platform !== 'darwin') throw new Error('The Omni modern helper requires macOS.')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = releaseProfile(process.env.OMNICODE_RELEASE_PROFILE)
const requestedArch = process.env.OMNICODE_TARGET_ARCH || process.arch
const arch = requestedArch === 'x64' ? 'x86_64' : requestedArch === 'arm64' ? 'arm64' : null
if (!arch) throw new Error(`Unsupported architecture: ${requestedArch}`)
const bundle = path.join(root, 'out/native/omnicode-modern-helper.app')
const binary = path.join(bundle, 'Contents/MacOS/omnicode-modern-helper')
const plist = path.join(bundle, 'Contents/Info.plist')
const source = path.join(root, 'native/omni-modern-helper', profile.id === 'current' ? 'main.swift' : 'legacy.swift')
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr || result.stdout).trim().slice(0, 8_000)}`)
}

await rm(bundle, { recursive: true, force: true })
await mkdir(path.dirname(binary), { recursive: true })
run('xcrun', [
  'swiftc', '-parse-as-library', '-target', `${arch}-apple-macos${profile.minimumMacOS}`, source, '-o', binary,
  ...(profile.id === 'current' ? ['-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'Translation', '-framework', 'Vision'] : [])
])
await chmod(binary, 0o755)
await copyFile(path.join(root, 'build/omni-modern-helper.Info.plist'), plist)
run('/usr/libexec/PlistBuddy', ['-c', `Set :LSMinimumSystemVersion ${profile.minimumMacOS}`, plist])
run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${version}`, plist])
run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle])
console.log(`Built Omni native feature helper: ${profile.label}, ${arch}, macOS ${profile.minimumMacOS}+.`)
