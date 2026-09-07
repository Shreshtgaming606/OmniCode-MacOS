import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)

async function apple(...expressions) {
  const args = expressions.flatMap((expression) => ['-e', expression])
  return (await execFileAsync('/usr/bin/osascript', args, { timeout: 5_000 })).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 125))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function frontmost() {
  await apple('tell application "OmniCode" to activate')
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to get frontmost')) === 'true',
    'OmniCode to become frontmost'
  )
}
async function macKeystroke(character, modifiers) {
  await frontmost()
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(character)} using {${modifiers.join(', ')}}`)
}

let target
await waitFor(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
  target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  return Boolean(target)
}, 'packaged renderer target', 30_000)
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
  const response = await call('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
  })
  if (response.exceptionDetails) throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\nExpression:\n${body}`)
  return response.result.value
}
async function waitForRenderer(expression, timeoutMs = 20_000) {
  await waitFor(async () => Boolean(await evaluate(`return Boolean(${expression})`).catch(() => false)), expression, timeoutMs)
}
async function terminalText() {
  return evaluate(`return document.querySelector('.terminal-panel__screen.is-active:not(.is-secondary) .xterm-rows')?.innerText ?? ''`)
}
async function sendTerminalText(text) {
  await frontmost()
  await evaluate(`document.querySelector('.terminal-panel__screen.is-active:not(.is-secondary) .xterm-helper-textarea').focus(); return true`)
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(text)}`)
  await apple('tell application "System Events" to key code 36')
}
async function terminalKey(key) {
  const keyCodes = { ArrowUp: 126, Enter: 36 }
  const keyCode = keyCodes[key]
  if (!keyCode) throw new Error(`Unsupported terminal audit key: ${key}`)
  await frontmost()
  await evaluate(`document.querySelector('.terminal-panel__screen.is-active:not(.is-secondary) .xterm-helper-textarea').focus(); return true`)
  await apple(`tell application "System Events" to key code ${keyCode}`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)

if (!(await evaluate(`return !document.querySelector('.terminal-panel')?.hidden`))) {
  await macKeystroke('`', ['command down'])
}
await waitForRenderer(`document.querySelector('.terminal-panel') && !document.querySelector('.terminal-panel').hidden`)
await waitForRenderer(`document.querySelectorAll('.terminal-panel__tab').length >= 1 && document.querySelector('.xterm-helper-textarea')`)

const marker = `OMNICODE_HISTORY_${Date.now()}`
await sendTerminalText(`printf '${marker}\\n'`)
await waitFor(async () => (await terminalText()).includes(marker), 'terminal marker output')
const initialMarkerCount = ((await terminalText()).match(new RegExp(marker, 'gu')) ?? []).length
await terminalKey('ArrowUp')
await terminalKey('Enter')
await waitFor(async () => ((await terminalText()).match(new RegExp(marker, 'gu')) ?? []).length > initialMarkerCount, 'shell history to rerun the previous command')

await evaluate(`document.querySelector('button[aria-label="Search terminal output"]').click(); return true`)
await waitForRenderer(`document.querySelector('.terminal-panel__search input')`)
await evaluate(`
  const input = document.querySelector('.terminal-panel__search input')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(marker)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
`)
await waitForRenderer(`!document.querySelector('.terminal-panel__search button[type="submit"]').disabled`)
await evaluate(`document.querySelector('.terminal-panel__search button[type="submit"]').click(); return true`)
await waitForRenderer(`document.querySelectorAll('.terminal-panel__screen.is-active .xterm-selection div').length > 0`)
await evaluate(`document.querySelector('button[aria-label="Close terminal search"]').click(); return true`)

await evaluate(`document.querySelector('button[aria-label="Clear active terminal"]').click(); return true`)
await waitFor(async () => !(await terminalText()).includes(marker), 'terminal clear to remove scrollback')

const beforeNew = await evaluate(`return document.querySelectorAll('.terminal-panel__tab').length`)
await macKeystroke('`', ['control down', 'shift down'])
await waitForRenderer(`document.querySelectorAll('.terminal-panel__tab').length === ${beforeNew + 1}`)
const switching = await evaluate(`
  const tabs = [...document.querySelectorAll('.terminal-panel__tab')]
  tabs[0].click()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const firstSelected = tabs[0].getAttribute('aria-selected') === 'true'
  tabs.at(-1).click()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const lastSelected = tabs.at(-1).getAttribute('aria-selected') === 'true'
  return { firstSelected, lastSelected }
`)
if (!switching.firstSelected || !switching.lastSelected) throw new Error('Terminal tabs did not reflect session switching.')

const beforeSplit = await evaluate(`return document.querySelectorAll('.terminal-panel__tab').length`)
await evaluate(`document.querySelector('button[aria-label="Split terminal"]').click(); return true`)
await waitForRenderer(`document.querySelectorAll('.terminal-panel__tab').length === ${beforeSplit + 1}`)
await waitForRenderer(`document.querySelectorAll('.terminal-panel__screen.is-active').length === 2`)

const beforeRestart = await evaluate(`
  const tab = document.querySelector('.terminal-panel__tab[aria-selected="true"]')
  return { id: tab?.id, label: tab?.textContent }
`)
await evaluate(`document.querySelector('button[aria-label="Restart active terminal"]').click(); return true`)
await waitForRenderer(`document.querySelector('.terminal-panel__tab[aria-selected="true"]')?.id !== ${JSON.stringify(beforeRestart.id)}`)
const afterRestartLabel = await evaluate(`return document.querySelector('.terminal-panel__tab[aria-selected="true"]')?.textContent`)
if (afterRestartLabel !== beforeRestart.label) throw new Error('Restart lost the active terminal identity.')

const beforeKill = await evaluate(`return document.querySelectorAll('.terminal-panel__tab').length`)
await evaluate(`document.querySelector('button[aria-label="Kill active terminal"]').click(); return true`)
await waitForRenderer(`document.querySelectorAll('.terminal-panel__tab').length === ${beforeKill - 1}`)
await evaluate(`document.querySelector('button[aria-label="Close terminal panel"]').click(); return true`)
await waitForRenderer(`document.querySelector('.terminal-panel').hidden`)

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  shellHistory: { commandExecuted: true, previousCommandReran: true },
  search: { markerFoundAndSelected: true },
  clear: { scrollbackRemoved: true },
  shortcut: { controlShiftBacktickCreatedSession: true },
  sessions: { switched: true, splitRendered: true, restarted: true, killed: true },
  panelClosed: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
