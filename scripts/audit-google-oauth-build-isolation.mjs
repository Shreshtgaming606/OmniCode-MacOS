import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.cwd()

function parseEnvFile(value) {
  const result = new Map()
  for (const line of value.split(/\r?\n/u)) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim())
    if (!match) continue
    const raw = match[2].trim()
    result.set(match[1], raw.replace(/^(?:"(.*)"|'(.*)')$/u, (_all, double, single) => double ?? single ?? ''))
  }
  return result
}

async function filesUnder(directory) {
  const result = []
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) result.push(target)
    }
  }
  await visit(directory)
  return result
}

async function contains(files, value) {
  if (!value) return false
  const needle = Buffer.from(value)
  for (const file of files) {
    const data = await fs.readFile(file).catch(() => Buffer.alloc(0))
    if (data.indexOf(needle) >= 0) return true
  }
  return false
}

const localEnvPath = path.join(root, '.env.local')
const localEnv = parseEnvFile(await fs.readFile(localEnvPath, 'utf8'))
const credentialsPath = localEnv.get('OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE')
if (!credentialsPath || !path.isAbsolute(credentialsPath)) {
  throw new Error('The local Google OAuth credentials path is missing or is not absolute.')
}

const credentialsRaw = await fs.readFile(credentialsPath, 'utf8')
const credentials = JSON.parse(credentialsRaw).installed
if (!credentials?.client_id || !credentials?.client_secret) {
  throw new Error('The local Google Desktop credentials are incomplete.')
}

const trackedOutput = await exec('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
const trackedFiles = trackedOutput.stdout.split('\0').filter(Boolean).map((file) => path.join(root, file))
const mainFiles = await filesUnder(path.join(root, 'out', 'main'))
const preloadFiles = await filesUnder(path.join(root, 'out', 'preload'))
const rendererFiles = await filesUnder(path.join(root, 'out', 'renderer'))
const packagedAsar = path.join(root, 'dist', 'mac', 'OmniCode.app', 'Contents', 'Resources', 'app.asar')
const packagedFiles = await fs.stat(packagedAsar).then(() => [packagedAsar]).catch(() => [])
const metadata = [credentials.client_id, credentials.client_secret]

const ignored = await exec('git', ['check-ignore', '-q', localEnvPath], { cwd: root })
  .then(() => true)
  .catch(() => false)
const mode = (await fs.stat(credentialsPath)).mode & 0o777
const report = {
  localEnvironmentIgnored: ignored,
  credentialFilePrivate: mode === 0o600,
  credentialFileOutsideRepository: !credentialsPath.startsWith(`${root}${path.sep}`),
  localPathAbsentFromTrackedSource: !(await contains(trackedFiles, credentialsPath)),
  localPathAbsentFromBuild: !(await contains([...mainFiles, ...preloadFiles, ...rendererFiles, ...packagedFiles], credentialsPath)),
  rawCredentialFileAbsentFromBuild: !(await contains([...mainFiles, ...preloadFiles, ...rendererFiles, ...packagedFiles], credentialsRaw)),
  desktopMetadataPresentInTrustedMain: (await Promise.all(metadata.map((value) => contains(mainFiles, value)))).every(Boolean),
  desktopMetadataAbsentFromPreload: (await Promise.all(metadata.map((value) => contains(preloadFiles, value)))).every((value) => !value),
  desktopMetadataAbsentFromRenderer: (await Promise.all(metadata.map((value) => contains(rendererFiles, value)))).every((value) => !value),
  desktopMetadataAbsentFromTrackedSource: (await Promise.all(metadata.map((value) => contains(trackedFiles, value)))).every((value) => !value)
}

if (Object.values(report).some((value) => value !== true)) {
  console.log(JSON.stringify(report, null, 2))
  throw new Error('The Google OAuth build-isolation audit failed.')
}
console.log(JSON.stringify(report, null, 2))
