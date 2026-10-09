import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('The Spotlight addon requires macOS.')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.env.OMNICODE_TARGET_ARCH === 'x64' ? 'x86_64' : 'arm64'
const electronVersion = JSON.parse(await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version
const headerRoot = path.join(process.env.HOME || '', '.electron-gyp', electronVersion, 'include/node')
const output = path.join(root, 'out/native/omnicode-spotlight.node')
await mkdir(path.dirname(output), { recursive: true })
const args = [
  'clang++', '-x', 'objective-c++', '-std=c++17', '-fobjc-arc', '-arch', arch,
  '-mmacosx-version-min=14.0', '-I', headerRoot,
  '-framework', 'Foundation', '-framework', 'CoreSpotlight',
  '-bundle', '-undefined', 'dynamic_lookup',
  path.join(root, 'native/omni-spotlight/spotlight.mm'), '-o', output
]
const result = spawnSync('xcrun', args, { cwd: root, encoding: 'utf8', timeout: 5 * 60_000 })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Spotlight addon build failed: ${String(result.stderr || result.stdout).slice(0, 8_000)}`)
console.log(`Built Core Spotlight addon for ${arch}, macOS 14.0+.`)
