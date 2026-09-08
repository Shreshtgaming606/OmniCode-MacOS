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
const before = await evaluate(`return {
  git: (await window.omnicode.tools.detect()).find((tool) => tool.id === 'git'),
  go: (await window.omnicode.tools.detect()).find((tool) => tool.id === 'go')
}`)
if (!before.git?.installed) throw new Error('The safe approval audit requires Git to already be installed.')
if (before.go?.installed || !before.go?.installable) throw new Error('The Setup UI audit requires missing, installable Go on this host.')

await waitFor(
  async () => {
    await apple('tell application "OmniCode" to activate')
    return (await apple('tell application "System Events" to tell process "OmniCode" to get frontmost')) === 'true'
  },
  'OmniCode to become frontmost'
)
await apple('tell application "System Events" to keystroke "p" using {command down, shift down}')
await waitFor(async () => evaluate(`return Boolean(document.querySelector('.palette input[placeholder="Type a command"]'))`), 'Command Palette')
await evaluate(`
  const input = document.querySelector('.palette input[placeholder="Type a command"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Setup & Install Tools')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
`)
await waitFor(async () => evaluate(`return [...document.querySelectorAll('.palette-results button')].some((item) => item.textContent?.includes('Setup & Install Tools'))`), 'Setup command')
await evaluate(`
  [...document.querySelectorAll('.palette-results button')].find((item) => item.textContent?.includes('Setup & Install Tools')).click()
  return true
`)
await waitFor(async () => evaluate(`return document.querySelector('.onboarding__header h1')?.textContent === 'Make OmniCode yours'`), 'Setup guide')
for (const heading of ['Development tools', 'Programming runtimes']) {
  await evaluate(`document.querySelector('.onboarding__footer .onboarding__button--primary').click(); return true`)
  await waitFor(async () => evaluate(`return document.querySelector('.onboarding__header h1')?.textContent === ${JSON.stringify(heading)}`), heading)
}
await waitFor(async () => evaluate(`return Boolean(document.querySelector('button[aria-label="Install Go"]:not(:disabled)'))`), 'Go Install button')
await evaluate(`document.querySelector('button[aria-label="Install Go"]').click(); return true`)
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
await waitFor(async () => evaluate(`return Boolean(document.querySelector('button[aria-label="Install Go"]:not(:disabled)'))`), 'cancelled Go action to settle')

for (const heading of ['Local AI with Ollama', 'Cloud AI providers', 'Ready to build']) {
  await evaluate(`document.querySelector('.onboarding__footer .onboarding__button--primary').click(); return true`)
  await waitFor(async () => evaluate(`return document.querySelector('.onboarding__header h1')?.textContent === ${JSON.stringify(heading)}`), heading)
}
await evaluate(`document.querySelector('.onboarding__footer .onboarding__button--primary').click(); return true`)
await waitFor(async () => evaluate(`return Boolean(document.querySelector('.app-shell'))`), 'workbench after Setup')

const after = await evaluate(`return {
  git: (await window.omnicode.tools.detect()).find((tool) => tool.id === 'git'),
  go: (await window.omnicode.tools.detect()).find((tool) => tool.id === 'go'),
  progress: (await window.omnicode.tools.installations()).find((item) => item.toolId === 'go'),
  idleCancel: await window.omnicode.tools.cancelInstallation('go'),
  invalidError: await window.omnicode.tools.install('go; touch /tmp/unsafe').then(() => '', (error) => String(error))
}`)
if (!after.git.installed || after.go.installed || after.progress || after.idleCancel || !/supported development tool/iu.test(after.invalidError)) {
  throw new Error(`Cancelled/invalid runtime request changed state: ${JSON.stringify(after)}`)
}

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  setupUI: { openedFromCommandPalette: true, programmingRuntimesStep: true, installButton: 'Install Go' },
  installedTool: { id: 'git', remainedInstalled: true },
  missingTool: { id: 'go', remainedMissing: true },
  nativeConfirmation: { buttons: ['Install', 'Cancel'], cancelSelected: true },
  noInstallerStarted: true,
  noProgressClaimed: true,
  idleCancel: false,
  invalidToolRejectedBeforeDialog: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
