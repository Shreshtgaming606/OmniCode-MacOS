import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageMetadata = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const argumentsByName = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || !value) {
    throw new Error('Usage: validate-macos-build.mjs [--arch arm64|x64] [--app PATH] [--dmg PATH] [--checksum PATH]')
  }
  argumentsByName.set(name, value)
}

const targetArchitecture = argumentsByName.get('--arch') ?? 'arm64'
if (!['arm64', 'x64'].includes(targetArchitecture)) {
  throw new Error(`Unsupported macOS architecture: ${targetArchitecture}`)
}
const expectedMachOArchitecture = targetArchitecture === 'x64' ? 'x86_64' : 'arm64'
const expectedPrebuildArchitecture = targetArchitecture === 'x64' ? 'darwin-x64' : 'darwin-arm64'
const defaultAppDirectory = targetArchitecture === 'x64' ? 'mac' : 'mac-arm64'
const defaultOutputDirectory = targetArchitecture === 'x64' ? 'release-x64' : 'release-arm64'
const appPath = argumentsByName.has('--app')
  ? path.resolve(argumentsByName.get('--app'))
  : path.join(projectRoot, 'dist', defaultOutputDirectory, defaultAppDirectory, 'OmniCode.app')
const dmgPath = argumentsByName.has('--dmg') ? path.resolve(argumentsByName.get('--dmg')) : undefined
const checksumPath = argumentsByName.has('--checksum') ? path.resolve(argumentsByName.get('--checksum')) : undefined
let passed = 0
let warnings = 0
let failures = 0

function result(command, args, timeout = 120_000) {
  const operation = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true })
  return {
    status: operation.status ?? -1,
    output: `${operation.stdout ?? ''}${operation.stderr ?? ''}`.trim(),
    error: operation.error
  }
}

function pass(message) {
  passed += 1
  console.log(`PASS — ${message}`)
}

function warn(message) {
  warnings += 1
  console.log(`WARNING — ${message}`)
}

function fail(message) {
  failures += 1
  console.log(`FAIL — ${message}`)
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false)
}

async function walk(directory) {
  const found = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await walk(target))
    else if (entry.isFile()) found.push(target)
  }
  return found
}

async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

function invalidSignatureDiagnostic(output) {
  return /code has no resources|signature does not fully cover|file added after|sealed resource.*(?:missing|invalid)|resource envelope.*(?:invalid|obsolete)|malformed|invalid signature/i.test(output)
}

async function validateApp(candidate, label) {
  console.log(`\n## ${label}: ${candidate}`)
  if (!await exists(candidate)) {
    fail(`${label} does not exist.`)
    return
  }

  const plist = path.join(candidate, 'Contents', 'Info.plist')
  const required = [
    'Contents/MacOS/OmniCode',
    'Contents/Frameworks',
    'Contents/Resources',
    'Contents/Resources/app.asar',
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node',
    'Contents/Resources/omni-native/omnicode-cursor-helper',
    'Contents/Resources/omni-native/omnicode-speech-helper.app/Contents/Info.plist',
    'Contents/Resources/omni-native/omnicode-speech-helper.app/Contents/MacOS/omnicode-speech-helper'
  ]
  for (const relative of required) {
    if (await exists(path.join(candidate, relative))) pass(`${label} contains ${relative}.`)
    else fail(`${label} is missing ${relative}.`)
  }

  const plistLint = result('/usr/bin/plutil', ['-lint', plist])
  if (plistLint.status === 0) pass(`${label} Info.plist is valid.`)
  else fail(`${label} Info.plist is invalid: ${plistLint.output}`)

  const expectedPlist = new Map([
    ['CFBundleExecutable', 'OmniCode'],
    ['CFBundleIdentifier', 'com.omnicode.editor'],
    ['CFBundleName', 'OmniCode'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', packageMetadata.version]
  ])
  for (const [key, expected] of expectedPlist) {
    const query = result('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
    if (query.status === 0 && query.output === expected) pass(`${key}=${expected}.`)
    else fail(`${key} expected ${expected}, received ${query.output || '<missing>'}.`)
  }

  console.log('\nPATH\tTYPE\tARCHITECTURE\tREQUIRED AT RUNTIME\tSTATUS')
  for (const file of await walk(candidate)) {
    const description = result('/usr/bin/file', ['-b', file])
    if (!description.output.includes('Mach-O')) continue
    const relative = path.relative(candidate, file)
    const architectures = result('/usr/bin/lipo', ['-archs', file]).output
    const nodePtyPrebuild = relative.includes('node_modules/node-pty/prebuilds/')
    const inactiveOtherArchitecturePrebuild = nodePtyPrebuild && !relative.includes(`node_modules/node-pty/prebuilds/${expectedPrebuildArchitecture}/`)
    const requiredAtRuntime = inactiveOtherArchitecturePrebuild ? 'NO' : 'YES'
    const healthy = inactiveOtherArchitecturePrebuild || architectures.split(/\s+/u).includes(expectedMachOArchitecture)
    console.log(`${relative}\t${description.output}\t${architectures}\t${requiredAtRuntime}\t${healthy ? 'PASS' : 'FAIL'}`)
    if (!healthy) fail(`${relative} is required at runtime but has no ${expectedMachOArchitecture} slice.`)
  }
  pass(`${label} Mach-O inventory contains no required component missing ${expectedMachOArchitecture}.`)

  const helperExecutables = [
    'Contents/Resources/omni-native/omnicode-cursor-helper',
    'Contents/Resources/omni-native/omnicode-speech-helper.app/Contents/MacOS/omnicode-speech-helper'
  ]
  for (const relative of helperExecutables) {
    const mode = (await fs.stat(path.join(candidate, relative))).mode
    if ((mode & 0o111) !== 0) pass(`${relative} is executable.`)
    else fail(`${relative} is not executable.`)
  }

  const speechHelperBundle = path.join(candidate, 'Contents/Resources/omni-native/omnicode-speech-helper.app')
  const speechHelper = path.join(speechHelperBundle, 'Contents/MacOS/omnicode-speech-helper')
  const speechInfoPlist = path.join(speechHelperBundle, 'Contents/Info.plist')
  const speechIdentity = result('/usr/bin/codesign', ['-dv', '--verbose=4', speechHelperBundle])
  if (/Identifier=com\.omnicode\.editor\.speech-helper/u.test(speechIdentity.output)) {
    pass('Speech helper has the stable com.omnicode.editor.speech-helper signing identity.')
  } else fail(`Speech helper has an unexpected signing identity: ${speechIdentity.output}`)
  const speechPrivacy = result('/usr/bin/plutil', ['-p', speechInfoPlist])
  if (speechPrivacy.status === 0 && speechPrivacy.output.includes('NSSpeechRecognitionUsageDescription') &&
      speechPrivacy.output.includes('NSMicrophoneUsageDescription')) {
    pass('Speech helper app has microphone and Speech Recognition privacy descriptions.')
  } else fail('Speech helper app is missing its privacy usage descriptions.')
  const speechEntitlements = result('/usr/bin/codesign', ['-d', '--entitlements', ':-', speechHelperBundle])
  if (speechEntitlements.output.includes('com.apple.security.device.audio-input')) {
    pass('Speech helper retains the narrow audio-input entitlement.')
  } else fail('Speech helper is missing its audio-input entitlement.')

  const signature = result('/usr/bin/codesign', ['-dv', '--verbose=4', candidate])
  const signingState = /Signature=adhoc/u.test(signature.output)
    ? 'ad-hoc'
    : /Authority=Developer ID Application/u.test(signature.output)
      ? 'Developer ID'
      : /not signed at all/iu.test(signature.output)
        ? 'unsigned'
        : 'unknown'
  if (signingState === 'Developer ID') pass(`${label} is Developer ID signed.`)
  else warn(`${label} signing state is ${signingState}; this is not a public distribution identity.`)

  const deep = result('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', candidate])
  if (deep.status === 0) pass(`${label} passes codesign --deep --strict.`)
  else if (signingState === 'unsigned' && /not signed at all/iu.test(deep.output)) warn(`${label} is intentionally unsigned.`)
  else fail(`${label} has an invalid code signature: ${deep.output}`)

  const policy = result('/usr/bin/syspolicy_check', ['distribution', candidate])
  console.log(`\n### syspolicy_check distribution (${label})\n${policy.output || '<no output>'}`)
  if (policy.status === 0) pass(`${label} passes distribution policy.`)
  else if (invalidSignatureDiagnostic(policy.output)) fail(`${label} has a malformed or incomplete signature according to syspolicy_check.`)
  else warn(`${label} fails distribution policy only because its trust/notarization requirements are unmet.`)

  const assessment = result('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vvv', candidate])
  console.log(`\n### spctl exec (${label})\n${assessment.output || '<no output>'}`)
  if (assessment.status === 0) pass(`${label} passes Gatekeeper execution assessment.`)
  else if (invalidSignatureDiagnostic(assessment.output)) fail(`${label} is rejected because its signature is invalid.`)
  else warn(`${label} is rejected by Gatekeeper because it lacks a trusted notarized distribution identity.`)
}

await validateApp(appPath, 'unpacked app')

if (dmgPath) {
  console.log(`\n## DMG: ${dmgPath}`)
  if (!await exists(dmgPath)) {
    fail('DMG does not exist.')
  } else {
    const verify = result('/usr/bin/hdiutil', ['verify', dmgPath], 5 * 60_000)
    console.log(`\n### hdiutil verify\n${verify.output || '<no output>'}`)
    if (verify.status === 0) pass('DMG passes hdiutil integrity verification.')
    else fail(`DMG integrity verification failed: ${verify.output}`)

    const dmgPolicy = result('/usr/sbin/spctl', [
      '-a', '-t', 'open', '-vvv', '--context', 'context:primary-signature', dmgPath
    ])
    console.log(`\n### spctl open DMG\n${dmgPolicy.output || '<no output>'}`)
    if (dmgPolicy.status === 0) pass('DMG passes Gatekeeper open assessment.')
    else if (invalidSignatureDiagnostic(dmgPolicy.output)) fail('DMG has an invalid signature or malformed contents.')
    else warn('DMG is rejected because it lacks a trusted notarized distribution identity.')

    const mountPoint = await fs.mkdtemp(path.join(tmpdir(), 'omnicode-dmg-validation-'))
    let mounted = false
    try {
      const attach = result('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath], 5 * 60_000)
      if (attach.status !== 0) fail(`DMG could not be mounted: ${attach.output}`)
      else {
        mounted = true
        pass('DMG mounts read-only.')
        const mountedApp = path.join(mountPoint, 'OmniCode.app')
        await validateApp(mountedApp, 'app inside DMG')
        const comparison = result('/usr/bin/diff', ['-qr', appPath, mountedApp], 5 * 60_000)
        if (comparison.status === 0) pass('The app inside the DMG is byte-for-byte file-content equivalent to the validated unpacked app.')
        else fail(`The DMG app differs from the validated unpacked app: ${comparison.output}`)
      }
    } finally {
      if (mounted) {
        const detach = result('/usr/bin/hdiutil', ['detach', mountPoint], 120_000)
        if (detach.status === 0) pass('DMG detached cleanly.')
        else warn(`DMG detach reported: ${detach.output}`)
      }
      await fs.rm(mountPoint, { recursive: true, force: true })
    }

    const digest = await sha256(dmgPath)
    pass(`DMG SHA-256 is ${digest}.`)
    if (checksumPath) {
      if (!await exists(checksumPath)) fail('DMG checksum file does not exist.')
      else {
        const checksum = (await fs.readFile(checksumPath, 'utf8')).trim().split(/\s+/u)[0]
        if (checksum === digest) pass('DMG checksum file matches the validated DMG.')
        else fail(`DMG checksum file does not match: expected ${digest}, received ${checksum || '<empty>'}.`)
      }
    }
  }
}

console.log(`\nSUMMARY — ${passed} PASS, ${warnings} WARNING, ${failures} FAIL`)
if (failures > 0) process.exitCode = 1
