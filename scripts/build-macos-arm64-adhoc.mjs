import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageMetadata = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const outputRoot = path.join(projectRoot, 'dist', 'release-arm64')
const appPath = path.join(outputRoot, 'mac-arm64', 'OmniCode.app')
const dmgName = `OmniCode-${packageMetadata.version}-arm64.dmg`
const dmgPath = path.join(outputRoot, dmgName)
const checksumPath = `${dmgPath}.sha256`
const buildWithoutGoogleOAuth = process.argv.includes('--without-google-oauth')

if (process.platform !== 'darwin') throw new Error('The macOS arm64 package must be built on macOS.')
if (process.arch !== 'arm64') throw new Error(`The native arm64 package must be built by an arm64 Node process, not ${process.arch}.`)

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeout ?? 20 * 60_000,
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(`${command} failed with exit code ${result.status}.${detail ? `\n${detail}` : ''}`)
  }
  return result
}

async function removeGenerated(target, allowed) {
  const resolved = path.resolve(target)
  if (!allowed.includes(resolved) || !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove unexpected path: ${resolved}`)
  }
  await fs.rm(resolved, { recursive: true, force: true })
}

async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

const allowedGeneratedPaths = [path.join(projectRoot, 'out'), outputRoot]
await removeGenerated(path.join(projectRoot, 'out'), allowedGeneratedPaths)
await removeGenerated(outputRoot, allowedGeneratedPaths)

const architectureEnvironment = {
  OMNICODE_TARGET_ARCH: 'arm64',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ...(buildWithoutGoogleOAuth
    ? { OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: '', OMNICODE_GOOGLE_OAUTH_TESTING: '0' }
    : {})
}

run('npx', ['--no-install', 'electron-builder', 'install-app-deps'], { env: architectureEnvironment })
run('npm', ['run', 'build'], { env: architectureEnvironment })
run('npx', [
  '--no-install', 'electron-builder', '--mac', '--arm64', '--dir',
  `--config.directories.output=${path.relative(projectRoot, outputRoot)}`,
  '--config.mac.identity=-', '--config.mac.hardenedRuntime=false', '--config.mac.notarize=false'
], { env: architectureEnvironment })

const cursorHelper = path.join(appPath, 'Contents', 'Resources', 'omni-native', 'omnicode-cursor-helper')
const speechHelper = path.join(appPath, 'Contents', 'Resources', 'omni-native', 'omnicode-speech-helper.app')

// electron-builder's recursive signing pass gives extraResource binaries the
// generic Electron child entitlements. Restore each helper's narrower profile,
// then reseal only the completed outer bundle so its resource envelope records
// the final nested signatures.
run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', cursorHelper])
run('/usr/bin/codesign', [
  '--force', '--sign', '-', '--timestamp=none', '--options', 'runtime',
  '--entitlements', path.join(projectRoot, 'build', 'entitlements.omni-speech.plist'), speechHelper
])
run('/usr/bin/codesign', [
  '--force', '--sign', '-', '--timestamp=none',
  '--entitlements', path.join(projectRoot, 'build', 'entitlements.mac.plist'), appPath
])

run('node', ['scripts/validate-macos-build.mjs', '--arch', 'arm64', '--app', appPath])
run('npx', [
  '--no-install', 'electron-builder', '--mac', 'dmg', '--arm64', '--prepackaged', appPath,
  `--config.directories.output=${path.relative(projectRoot, outputRoot)}`,
  '--config.mac.identity=-', '--config.mac.hardenedRuntime=false', '--config.mac.notarize=false'
], { env: architectureEnvironment })

const digest = await sha256(dmgPath)
await fs.writeFile(checksumPath, `${digest}  ${dmgName}\n`, { mode: 0o644 })
run('node', [
  'scripts/validate-macos-build.mjs', '--arch', 'arm64', '--app', appPath,
  '--dmg', dmgPath, '--checksum', checksumPath
])

console.log('\nARM64 ad-hoc diagnostic package complete.')
console.log(`DMG: ${dmgPath}`)
console.log(`SHA-256: ${digest}`)
console.log(`Checksum file: ${checksumPath}`)
console.log('Classification: locally ad-hoc signed; not Developer ID signed; not notarized; not for public distribution.')
