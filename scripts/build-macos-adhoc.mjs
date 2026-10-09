import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { releaseArtifactName, releaseProfile } from './macos-release-profile.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const option = (name) => process.argv[process.argv.indexOf(name) + 1]
const profile = releaseProfile(process.argv.includes('--profile') ? option('--profile') : 'current')
const arch = process.argv.includes('--arch') ? option('--arch') : process.arch
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`)
if (process.platform !== 'darwin') throw new Error('macOS installers require a macOS build host.')
if (arch === 'arm64' && process.arch !== 'arm64') throw new Error('The native arm64 build requires an arm64 Node process.')

const outputRoot = path.join(projectRoot, 'dist', `release-${profile.id}-${arch}`)
const appPath = path.join(outputRoot, arch === 'x64' ? 'mac' : 'mac-arm64', 'OmniCode.app')
const dmgName = releaseArtifactName(metadata.version, profile, arch)
const dmgPath = path.join(outputRoot, dmgName)
const checksumPath = `${dmgPath}.sha256`
const buildEnvironment = {
  OMNICODE_TARGET_ARCH: arch,
  OMNICODE_RELEASE_PROFILE: profile.id,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ...(process.argv.includes('--without-google-oauth')
    ? { OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: '', OMNICODE_GOOGLE_OAUTH_TESTING: '0' }
    : {})
}
const builderConfig = [
  `--config.directories.output=${path.relative(projectRoot, outputRoot)}`,
  `--config.mac.minimumSystemVersion=${profile.minimumMacOS}`,
  `--config.artifactName=${dmgName}`,
  '--config.mac.identity=-', '--config.mac.hardenedRuntime=false', '--config.mac.notarize=false'
]

function run(command, args, env = buildEnvironment) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: projectRoot, env: { ...process.env, ...env }, stdio: 'inherit',
    timeout: 30 * 60_000, windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`)
}

async function removeGenerated(target) {
  if (![path.join(projectRoot, 'out'), outputRoot].includes(path.resolve(target))) {
    throw new Error(`Refusing to remove unexpected generated path: ${target}`)
  }
  await fs.rm(target, { recursive: true, force: true })
}

async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

// Each profile has its own output directory. Existing validated installers in
// the previous release directories remain untouched until a replacement passes.
await removeGenerated(path.join(projectRoot, 'out'))
await removeGenerated(outputRoot)
let buildFailure
try {
  run('npx', ['--no-install', 'electron-builder', 'install-app-deps', '--platform', 'darwin', '--arch', arch])
  run('npm', ['run', 'build'])
  run('npx', ['--no-install', 'electron-builder', '--mac', `--${arch}`, '--dir', ...builderConfig])

  const cursor = path.join(appPath, 'Contents/Resources/omni-native/omnicode-cursor-helper')
  const speech = path.join(appPath, 'Contents/Resources/omni-native/omnicode-speech-helper.app')
  const modern = path.join(appPath, 'Contents/Resources/omni-native/omnicode-modern-helper.app')
  const intents = path.join(appPath, 'Contents/Extensions/OmniCodeIntents.appex')
  // Preserve the repaired order: restore narrow nested signatures, then seal
  // the complete outer bundle. Nothing in the app is changed after this seal.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', cursor])
  run('/usr/bin/codesign', [
    '--force', '--sign', '-', '--timestamp=none', '--options', 'runtime',
    '--entitlements', path.join(projectRoot, 'build/entitlements.omni-speech.plist'), speech
  ])
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', modern])
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', path.join(projectRoot, 'build/entitlements.omni-intents.plist'), intents])
  run('/usr/bin/codesign', [
    '--force', '--sign', '-', '--timestamp=none',
    '--entitlements', path.join(projectRoot, 'build/entitlements.mac.plist'), appPath
  ])
  run('node', ['scripts/validate-macos-build.mjs', '--profile', profile.id, '--arch', arch, '--app', appPath])
  run('npx', [
    '--no-install', 'electron-builder', '--mac', 'dmg', `--${arch}`, '--prepackaged', appPath, ...builderConfig
  ])
  const digest = await sha256(dmgPath)
  await fs.writeFile(checksumPath, `${digest}  ${dmgName}\n`, { mode: 0o644 })
  run('node', [
    'scripts/validate-macos-build.mjs', '--profile', profile.id, '--arch', arch,
    '--app', appPath, '--dmg', dmgPath, '--checksum', checksumPath
  ])
  console.log(`${profile.label} ${arch} installer: ${dmgPath}`)
  console.log(`SHA-256: ${digest}`)
} catch (error) {
  buildFailure = error
} finally {
  if (arch === 'x64' && process.arch !== 'x64') {
    // Restore the active Apple Silicon developer environment after cross-build.
    try {
      run('npx', ['--no-install', 'electron-builder', 'install-app-deps', '--platform', 'darwin', '--arch', process.arch], {
        OMNICODE_TARGET_ARCH: process.arch, OMNICODE_RELEASE_PROFILE: 'current', CSC_IDENTITY_AUTO_DISCOVERY: 'false'
      })
      run('npm', ['run', 'build:native'], {
        OMNICODE_TARGET_ARCH: process.arch, OMNICODE_RELEASE_PROFILE: 'current', CSC_IDENTITY_AUTO_DISCOVERY: 'false'
      })
    } catch (error) {
      if (!buildFailure) buildFailure = error
      else console.error(`Developer dependency restoration failed: ${String(error)}`)
    }
  }
}
if (buildFailure) throw buildFailure
console.log('Ad-hoc signed and unnotarized: Gatekeeper trust is not established for public distribution.')
