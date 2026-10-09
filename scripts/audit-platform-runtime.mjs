import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'

const appBinary = process.argv[2]
const expected = process.argv[3]
if (!appBinary?.includes('.app/Contents/MacOS/') || !['current', 'legacy'].includes(expected)) {
  throw new Error('Usage: node scripts/audit-platform-runtime.mjs <app-binary> current|legacy')
}
await fs.access(appBinary)
const profile = await fs.mkdtemp(path.join(tmpdir(), 'omnicode-platform-audit-'))
const listener = net.createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const child = spawn(appBinary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' })
let socket
let passed = false

async function target() {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
    const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && !item.url?.includes('omni-overlay'))
    if (page) return page
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('Timed out waiting for packaged OmniCode renderer.')
}

try {
  const page = await target()
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if (!message.id) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry?.reject(new Error(message.error.message))
    else entry?.resolve(message.result)
  })
  const evaluate = async (body) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
    } }))
    const response = await new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  const deadline = Date.now() + 30_000
  let snapshot
  while (Date.now() < deadline) {
    snapshot = await evaluate('return window.omnicode ? await window.omnicode.platform.snapshot() : null').catch(() => null)
    if (snapshot) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!snapshot || snapshot.release !== expected) throw new Error(`Packaged release identity mismatch: ${snapshot?.release ?? 'unavailable'}`)
  const tools = await evaluate('return (await window.omnicode.work.tools.list()).map(item => item.id)')
  if (tools.includes('system.translate') !== (expected === 'current')) throw new Error('Native Work tool exposure does not match release profile.')
  if (expected === 'current') {
    const response = await evaluate(`return await window.omnicode.work.tools.execute({ toolId: 'system.translate', mode: 'work', input: { text: 'Hello world.', source: 'en', target: 'es' } })`)
    if (response?.result?.text !== 'Hola mundo.') throw new Error('Packaged Work Mode native translation failed.')
  }
  if (process.argv.includes('--capture')) {
    if (expected !== 'current') throw new Error('Modern window capture is unavailable in Sonoma Legacy.')
    const windowLookup = `
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let matching = windows.filter { window in
  guard (window[kCGWindowOwnerPID as String] as? Int32) == pid,
        let bounds = window[kCGWindowBounds as String] as? [String: Any],
        let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double else { return false }
  return width > 300 && height > 200
}
let identifier = matching.compactMap { $0[kCGWindowNumber as String] as? Int }.first ?? 0
print(identifier)
`
    const found = spawnSync('xcrun', ['swift', '-e', windowLookup, String(child.pid)], { encoding: 'utf8', timeout: 30_000 })
    const windowId = Number(found.stdout?.trim())
    if (found.error || found.status !== 0 || !Number.isSafeInteger(windowId) || windowId <= 0) {
      throw new Error('Could not identify the packaged OmniCode window for a targeted capture test.')
    }
    const helper = process.env.OMNICODE_AUDIT_HELPER_PATH || path.join(appBinary.slice(0, appBinary.indexOf('/Contents/MacOS/')), 'Contents/Resources/omni-native/omnicode-modern-helper.app/Contents/MacOS/omnicode-modern-helper')
    const outputPath = path.join(profile, 'window.png')
    const captured = spawnSync(helper, [], { input: JSON.stringify({ command: 'capture-window', windowId, outputPath }), encoding: 'utf8', timeout: 45_000 })
    if (captured.error || captured.status !== 0) {
      throw new Error(`ScreenCaptureKit helper did not complete a window-specific capture (exit ${captured.status}, signal ${captured.signal ?? 'none'}, ${captured.error?.code ?? 'no process error'}; stderr ${String(captured.stderr || '').trim().slice(0, 500)}).`)
    }
    const response = JSON.parse(captured.stdout)
    if (!response.ok || response.result?.scope !== 'OmniCode window only') {
      throw new Error(response.error || 'Window-specific ScreenCaptureKit capture failed.')
    }
    const header = (await fs.readFile(outputPath)).subarray(0, 8).toString('hex')
    if (header !== '89504e470d0a1a0a') throw new Error('Window capture output is not a PNG image.')
    console.log('PASS — packaged ScreenCaptureKit captured only the OmniCode window into a local PNG.')
  }
  passed = true
  console.log(`PASS — packaged ${expected} profile reports macOS ${snapshot.minimumMacOS}+ on ${snapshot.architecture}.`)
  console.log(`PASS — packaged ${expected} Work tool exposure matches profile.`)
  if (expected === 'current') console.log('PASS — packaged Work Mode invoked Apple Translation without an AI provider.')
} finally {
  socket?.close()
  child.kill('SIGTERM')
  await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) })
  if (passed) await fs.rm(profile, { recursive: true, force: true })
  else console.error(`Preserved failed-runtime diagnostic profile: ${profile}`)
}
