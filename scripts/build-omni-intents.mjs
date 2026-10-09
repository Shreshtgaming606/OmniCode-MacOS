import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { releaseProfile } from './macos-release-profile.mjs'

if (process.platform !== 'darwin') throw new Error('App Intents require macOS.')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requested = process.env.OMNICODE_TARGET_ARCH || process.arch
const profile = releaseProfile(process.env.OMNICODE_RELEASE_PROFILE)
const arch = requested === 'x64' ? 'x86_64' : requested === 'arm64' ? 'arm64' : null
if (!arch) throw new Error(`Unsupported App Intents architecture: ${requested}`)
const project = path.join(root, 'native/omni-intents/OmniCodeIntents.xcodeproj')
const generatedSource = path.join(root, 'out/native/OmniCodeIntents.swift')
const source = path.join(root, 'native/omni-intents/OmniCodeIntents.swift')
const shortcutSource = path.join(root, 'native/omni-intents', profile.id === 'current' ? 'CurrentShortcuts.swift' : 'LegacyShortcuts.swift')
const buildDir = path.join(root, `out/native/xcode-intents-${profile.id}-${arch}`)
const builtBundle = path.join(buildDir, 'Release/OmniCodeIntents.appex')
const bundle = path.join(root, 'out/native/OmniCodeIntents.appex')
const plist = path.join(bundle, 'Contents/Info.plist')
const metadata = path.join(bundle, 'Contents/Resources/Metadata.appintents/extract.actionsdata')
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr || result.stdout).trim().slice(0, 8_000)}`)
  return String(result.stdout).trim()
}

// A hand-wrapped swiftc executable registers but crashes inside
// ExtensionFoundation before any OmniCode intent can run. Xcode's real
// app-extension target supplies the required extension entry-point setup.
await mkdir(path.dirname(generatedSource), { recursive: true })
await writeFile(generatedSource, `${await readFile(source, 'utf8')}\n${await readFile(shortcutSource, 'utf8')}\n`)
run('xcodebuild', [
  '-quiet', '-project', project, '-target', 'OmniCodeIntents',
  '-configuration', 'Release', '-sdk', 'macosx', '-arch', arch,
  `SYMROOT=${buildDir}`, 'CODE_SIGNING_ALLOWED=NO',
  `MACOSX_DEPLOYMENT_TARGET=${profile.minimumMacOS}`, 'build'
])
await rm(bundle, { recursive: true, force: true })
run('/usr/bin/ditto', [builtBundle, bundle])
run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${version}`, plist])
run('/usr/libexec/PlistBuddy', ['-c', `Set :LSMinimumSystemVersion ${profile.minimumMacOS}`, plist])
const actions = JSON.parse(await readFile(metadata, 'utf8'))
const expected = profile.id === 'current' ? 8 : 7
if (!Array.isArray(actions.autoShortcuts) || actions.autoShortcuts.length !== expected) {
  throw new Error(`App Intents metadata should contain ${expected} shortcuts for ${profile.label}.`)
}
run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', path.join(root, 'build/entitlements.omni-intents.plist'), bundle])
console.log(`Built OmniCode App Intents extension with Xcode: ${profile.label}, ${arch}, macOS ${profile.minimumMacOS}+.`)
