import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const workspace = await fs.realpath(process.argv[3] ?? '')
const textEditPath = '/System/Applications/TextEdit.app'

async function apple(...expressions) {
  const args = expressions.flatMap((expression) => ['-e', expression])
  return (await execFileAsync('/usr/bin/osascript', args)).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
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
async function keystroke(character, modifiers = []) {
  await frontmost()
  const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : ''
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(character)}${using}`)
}
async function keyCode(code) {
  await frontmost()
  await apple(`tell application "System Events" to key code ${code}`)
}
function parseIds(value) {
  if (!value.trim()) return []
  return value.split(',').map((item) => Number.parseInt(item.trim(), 10)).filter(Number.isFinite)
}
async function finderWindowIds() {
  return parseIds(await apple('tell application "Finder" to get id of every Finder window'))
}
async function finderSelection() {
  const url = await apple(
    'tell application "Finder"',
    'set chosenItems to selection',
    'if (count of chosenItems) is 0 then return ""',
    'return URL of item 1 of chosenItems',
    'end tell'
  )
  return url ? decodeURIComponent(new URL(url).pathname) : ''
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
async function openContextAction(fileName, label) {
  await evaluate(`
    const row = [...document.querySelectorAll('.tree-row')].find((item) => item.querySelector('.tree-label')?.textContent === ${JSON.stringify(fileName)})
    if (!row) throw new Error('Missing Explorer row for ' + ${JSON.stringify(fileName)})
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 180 }))
    return true
  `)
  await waitForRenderer(`[...document.querySelectorAll('.context-menu button')].some((item) => item.textContent?.includes(${JSON.stringify(label)}))`)
  await evaluate(`
    const item = [...document.querySelectorAll('.context-menu button')].find((button) => button.textContent?.includes(${JSON.stringify(label)}))
    item.click()
    return true
  `)
}

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(workspace.split('/').pop())}`)
if (!(await fs.stat(textEditPath)).isDirectory()) throw new Error(`TextEdit is unavailable at ${textEditPath}`)

const auditName = `OmniCode Finder ${Date.now()}`
const fileName = `Finder Integration ${Date.now()}.txt`
const auditRoot = `${workspace}/${auditName}`
const filePath = `${auditRoot}/${fileName}`
const content = `OmniCode Finder integration ${Date.now()}\n`
const initialFinderWindows = new Set(await finderWindowIds())
const textEditWasRunning = (await apple('tell application "System Events" to get name of every process')).split(', ').includes('TextEdit')

await evaluate(`
  const root = await window.omnicode.workspace.createEntry(${JSON.stringify(workspace)}, ${JSON.stringify(auditName)}, 'directory')
  const file = await window.omnicode.workspace.createEntry(root, ${JSON.stringify(fileName)}, 'file')
  await window.omnicode.workspace.writeFile(file, ${JSON.stringify(content)})
  document.querySelector('button[title="Refresh"]').click()
  return true
`)
await waitForRenderer(`[...document.querySelectorAll('.tree-label')].some((item) => item.textContent === ${JSON.stringify(auditName)})`)
await evaluate(`
  const row = [...document.querySelectorAll('.tree-row')].find((item) => item.querySelector('.tree-label')?.textContent === ${JSON.stringify(auditName)})
  row.click()
  return true
`)
await waitForRenderer(`[...document.querySelectorAll('.tree-label')].some((item) => item.textContent === ${JSON.stringify(fileName)})`)

await openContextAction(fileName, 'Reveal in Finder')
await waitFor(async () => (await finderSelection()) === filePath, 'Finder to select the exact file')
const revealedPath = await finderSelection()
await frontmost()

// Exercise the real Open With picker and choose the system TextEdit bundle.
await openContextAction(fileName, 'Open With')
await waitFor(
  async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '1',
  'native Open With sheet'
)
const buttons = await apple('tell application "System Events" to tell process "OmniCode" to get name of every button of sheet 1 of window 1')
if (!buttons.includes('Open')) throw new Error(`Open With sheet has no Open button: ${buttons}`)
await keystroke('g', ['command down', 'shift down'])
await new Promise((resolve) => setTimeout(resolve, 300))
await keystroke(textEditPath)
await keyCode(36)
await new Promise((resolve) => setTimeout(resolve, 500))
await apple('tell application "System Events" to tell process "OmniCode" to click button "Open" of sheet 1 of window 1')
await waitFor(
  async () => (await apple('tell application "System Events" to get name of every process')).split(', ').includes('TextEdit'),
  'TextEdit to launch'
)
await waitFor(
  async () => (await apple('tell application "System Events" to tell process "TextEdit" to get name of every window')).split(', ').includes(fileName),
  'TextEdit to open the selected file'
)
const openedContent = await apple('tell application "System Events" to tell process "TextEdit" to get value of text area 1 of scroll area 1 of window 1')
if (!openedContent.startsWith(content.trim())) throw new Error('TextEdit did not receive the exact selected file.')
await apple('tell application "System Events" to tell process "TextEdit" to click (first button of window 1 whose description is "close button")')
if (!textEditWasRunning) {
  await apple('tell application "TextEdit" to activate', 'tell application "System Events" to keystroke "q" using command down')
  await waitFor(
    async () => !(await apple('tell application "System Events" to get name of every process')).split(', ').includes('TextEdit'),
    'TextEdit to quit after the audit'
  )
}
await frontmost()

await evaluate(`await window.omnicode.workspace.trashEntry(${JSON.stringify(auditRoot)}); return true`)
if (await fs.stat(auditRoot).then(() => true, () => false)) throw new Error(`Audit directory was not removed: ${auditRoot}`)
const finalFinderWindows = await finderWindowIds()
for (const id of finalFinderWindows.filter((item) => !initialFinderWindows.has(item))) {
  await apple(`tell application "Finder" to close Finder window id ${id}`).catch(() => undefined)
}
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  revealInFinder: { contextMenuInvoked: true, exactSelection: revealedPath },
  openWith: { contextMenuInvoked: true, nativeSheet: true, application: textEditPath, exactDocumentOpened: true },
  cleanup: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
