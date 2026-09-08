import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9390)

async function apple(expression) {
  return (await execFileAsync('/usr/bin/osascript', ['-e', expression], { timeout: 5_000 })).stdout.trim()
}
async function hasSheet() {
  return (await apple(`
    tell application "System Events" to tell process "OmniCode"
      repeat with currentWindow in windows
        if (count of sheets of currentWindow) > 0 then return true
      end repeat
    end tell
    return false
  `)) === 'true'
}
async function sheetButtons() {
  return apple(`
    tell application "System Events" to tell process "OmniCode"
      repeat with currentWindow in windows
        if (count of sheets of currentWindow) > 0 then return name of every button of sheet 1 of currentWindow
      end repeat
    end tell
    return ""
  `)
}
async function clickSheetButton(name) {
  return apple(`
    tell application "System Events" to tell process "OmniCode"
      repeat with currentWindow in windows
        if (count of sheets of currentWindow) > 0 then
          click button ${JSON.stringify(name)} of sheet 1 of currentWindow
          return true
        end if
      end repeat
    end tell
    return false
  `)
}
async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

let target
await waitFor(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
  target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  return Boolean(target)
}, 'packaged renderer target')
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const runtimeErrors = []
let nextId = 1
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data))
  if (message.id) {
    const operation = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) operation?.reject(new Error(message.error.message))
    else operation?.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'Runtime exception')
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') runtimeErrors.push(message.params.entry.text)
})
function call(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(body) {
  const response = await call('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\nExpression:\n${body}`)
  return response.result.value
}

await call('Runtime.enable')
await call('Log.enable')
await waitFor(async () => evaluate(`return Boolean(window.omnicode && document.querySelector('.app-shell'))`), 'workbench')
const before = await evaluate(`return (await window.omnicode.tools.detect()).find((tool) => tool.id === 'git')`)
if (!before?.installed) throw new Error('The safe approval audit requires Git to already be installed.')

const installDecision = evaluate(`return await window.omnicode.tools.install('git')`)
await waitFor(
  hasSheet,
  'native runtime installation confirmation'
)
const buttons = await sheetButtons()
if (!buttons.includes('Install') || !buttons.includes('Cancel')) throw new Error(`Runtime confirmation buttons were incomplete: ${buttons}`)
if (await clickSheetButton('Cancel') !== 'true') throw new Error('The native Cancel button could not be invoked.')
await waitFor(
  async () => !(await hasSheet()),
  'cancelled runtime confirmation to close'
)
const cancelled = await installDecision
if (!cancelled.cancelled || cancelled.installed || cancelled.toolId !== 'git') {
  throw new Error(`Runtime cancellation result was inaccurate: ${JSON.stringify(cancelled)}`)
}

const after = await evaluate(`return {
  tool: (await window.omnicode.tools.detect()).find((tool) => tool.id === 'git'),
  progress: (await window.omnicode.tools.installations()).find((item) => item.toolId === 'git'),
  idleCancel: await window.omnicode.tools.cancelInstallation('git'),
  invalidError: await window.omnicode.tools.install('go; touch /tmp/unsafe').then(() => '', (error) => String(error))
}`)
if (!after.tool.installed || after.progress || after.idleCancel || !/supported development tool/iu.test(after.invalidError)) {
  throw new Error(`Cancelled/invalid runtime request changed state: ${JSON.stringify(after)}`)
}

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  installedTool: { id: 'git', remainedInstalled: true },
  nativeConfirmation: { buttons: ['Install', 'Cancel'], cancelSelected: true },
  noInstallerStarted: true,
  noProgressClaimed: true,
  idleCancel: false,
  invalidToolRejectedBeforeDialog: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
