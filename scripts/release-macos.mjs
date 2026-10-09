import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { releaseArtifactName, releaseProfile } from './macos-release-profile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const variants = [
  ['current', 'arm64'], ['current', 'x64'], ['legacy', 'arm64'], ['legacy', 'x64']
]

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 40 * 60_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}. Release manifest was not generated.`)
}

async function digest(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

run('npm', ['run', 'typecheck'])
run('npm', ['test'])
const manifest = { version: metadata.version, generatedAt: new Date().toISOString(), signing: 'ad-hoc-unnotarized', current: {}, legacySonoma: {} }
for (const [profileId, arch] of variants) {
  run('node', ['scripts/build-macos-adhoc.mjs', '--profile', profileId, '--arch', arch])
  const profile = releaseProfile(profileId)
  const filename = releaseArtifactName(metadata.version, profile, arch)
  const file = path.join(root, 'dist', `release-${profile.id}-${arch}`, filename)
  const checksum = await digest(file)
  const entry = {
    channel: profile.id, architecture: arch, minimumMacOS: profile.minimumMacOS,
    filename, relativePath: path.relative(root, file), sha256: checksum, bytes: (await fs.stat(file)).size
  }
  manifest[profile.id === 'current' ? 'current' : 'legacySonoma'][arch] = entry
}
const output = path.join(root, 'dist', 'release-macos', `OmniCode-${metadata.version}-release-manifest.json`)
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
console.log(`Validated four-profile release manifest: ${output}`)
console.log('All four artifacts are ad-hoc signed and unnotarized. Do not publish as Developer ID signed builds.')
