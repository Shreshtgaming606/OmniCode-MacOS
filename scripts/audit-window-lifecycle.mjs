import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const appPath = path.resolve(process.argv[3] ?? 'dist/mac/OmniCode.app')

async function apple(...expressions) {
  const args = expressions.flatMap((expression) => ['-e', expression])
  return (await execFileAsync('/usr/bin/osascript', args)).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function targets() {
  return fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
}
async function windowValue(attribute) {
  return apple(`tell application "System Events" to tell process "OmniCode" to get value of attribute ${JSON.stringify(attribute)} of window 1`)
}
async function windowFrame() {
  const raw = await apple('tell application "System Events" to tell process "OmniCode" to tell window 1 to get {position, size}')
  const values = raw.split(',').map((item) => Number.parseInt(item.trim(), 10))
  if (values.length !== 4 || values.some(Number.isNaN)) throw new Error(`Unexpected window frame: ${raw}`)
  return { x: values[0], y: values[1], width: values[2], height: values[3] }
}

await apple('tell application "OmniCode" to activate')
await waitFor(async () => (await apple('tell application "System Events" to tell process "OmniCode" to count windows')) === '1', 'one OmniCode window')
await waitFor(async () => (await targets()).some((target) => target.type === 'page'), 'packaged renderer target')

const original = await windowFrame()
await apple('tell application "System Events" to tell process "OmniCode" to tell window 1 to set {position, size} to {{80, 60}, {1100, 700}}')
await waitFor(async () => {
  const frame = await windowFrame()
  return frame.x === 80 && frame.y === 60 && frame.width === 1100 && frame.height === 700
}, 'explicit window resize')
const resized = await windowFrame()

await apple('tell application "System Events" to tell process "OmniCode" to set value of attribute "AXMinimized" of window 1 to true')
await waitFor(async () => (await windowValue('AXMinimized')) === 'true', 'window minimization')
await apple('tell application "System Events" to tell process "OmniCode" to set value of attribute "AXMinimized" of window 1 to false')
await waitFor(async () => (await windowValue('AXMinimized')) === 'false', 'window restoration')

await apple('tell application "System Events" to tell process "OmniCode" to click menu item "Zoom" of menu 1 of menu bar item "Window" of menu bar 1')
await waitFor(async () => {
  const frame = await windowFrame()
  return frame.width !== resized.width || frame.height !== resized.height
}, 'window zoom')
const zoomed = await windowFrame()
await apple('tell application "System Events" to tell process "OmniCode" to click menu item "Zoom" of menu 1 of menu bar item "Window" of menu bar 1')
await waitFor(async () => {
  const frame = await windowFrame()
  return frame.width === resized.width && frame.height === resized.height
}, 'window unzoom')

await apple('tell application "System Events" to tell process "OmniCode" to set value of attribute "AXFullScreen" of window 1 to true')
await waitFor(async () => (await windowValue('AXFullScreen')) === 'true', 'enter full screen', 30_000)
await apple('tell application "System Events" to tell process "OmniCode" to set value of attribute "AXFullScreen" of window 1 to false')
await waitFor(async () => (await windowValue('AXFullScreen')) === 'false', 'exit full screen', 30_000)

// Restore the starting frame before closing, then verify macOS close/reopen behavior.
await apple(`tell application "System Events" to tell process "OmniCode" to tell window 1 to set {position, size} to {{${original.x}, ${original.y}}, {${original.width}, ${original.height}}}`)
await apple('tell application "System Events" to tell process "OmniCode" to click (first button of window 1 whose description is "close button")')
await waitFor(async () => (await apple('tell application "System Events" to tell process "OmniCode" to count windows')) === '0', 'normal window close')
await waitFor(async () => !(await targets()).some((target) => target.type === 'page'), 'renderer shutdown')

await execFileAsync('/usr/bin/open', ['-a', appPath])
await waitFor(async () => (await apple('tell application "System Events" to tell process "OmniCode" to count windows')) === '1', 'window reopen')
await waitFor(async () => (await targets()).some((target) => target.type === 'page'), 'renderer recreation')

console.log(JSON.stringify({
  window: { resized, minimizedAndRestored: true, zoomed, fullScreenEnteredAndExited: true },
  lifecycle: { closedNormally: true, rendererStopped: true, reopened: true, rendererRecreated: true }
}, null, 2))
