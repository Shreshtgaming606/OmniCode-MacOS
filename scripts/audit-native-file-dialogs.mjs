import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const workspace = await fs.realpath(process.argv[3] ?? '')

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
async function waitForSheet() {
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '1',
    'native file dialog'
  )
}
async function rendererTarget() {
  let target
  await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
    target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    return Boolean(target)
  }, 'packaged renderer target', 30_000)
  return target
}

const target = await rendererTarget()
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
  if (message.method === 'Runtime.exceptionThrown') {
    runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'Runtime exception')
  }
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
async function setInput(selector, value) {
  await evaluate(`
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('Missing input: ' + ${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
}
async function openByQuickOpen(name) {
  await keystroke('p', ['command down'])
  await waitForRenderer(`document.querySelector('.palette input[placeholder="Search files by name"]')`)
  await setInput('.palette input[placeholder="Search files by name"]', name)
  await waitForRenderer(`[...document.querySelectorAll('.palette-results button strong')].some((item) => item.textContent === ${JSON.stringify(name)})`)
  await evaluate(`
    const strong = [...document.querySelectorAll('.palette-results button strong')].find((item) => item.textContent === ${JSON.stringify(name)})
    strong.closest('button').click()
    return true
  `)
  await waitForRenderer(`document.querySelector('.editor-tabs button[title$="/${name}"]')?.classList.contains('active')`)
}
async function replaceEditorText(name, value) {
  await frontmost()
  await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
  await apple('tell application "System Events" to keystroke "a" using command down')
  await waitForRenderer(`document.querySelectorAll('.monaco-editor .selected-text').length > 0`)
  await call('Input.insertText', { text: value })
  await waitForRenderer(`document.querySelector('.editor-tabs button[title$="/${name}"] .dirty-dot')`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(workspace.split('/').pop())}`)

const auditName = `OmniCode Native Dialog ${Date.now()}`
const sourceName = 'source.txt'
const savedName = `Saved As ${Date.now()}.txt`
const auditRoot = `${workspace}/${auditName}`
const sourcePath = `${auditRoot}/${sourceName}`
const savedPath = `${auditRoot}/${savedName}`
const saveAsContent = `native Save As exact content ${Date.now()}\n`
await evaluate(`
  const root = await window.omnicode.workspace.createEntry(${JSON.stringify(workspace)}, ${JSON.stringify(auditName)}, 'directory')
  const source = await window.omnicode.workspace.createEntry(root, ${JSON.stringify(sourceName)}, 'file')
  await window.omnicode.workspace.writeFile(source, 'native dialog baseline\\n')
  return true
`)
await openByQuickOpen(sourceName)
await replaceEditorText(sourceName, saveAsContent)

await keystroke('s', ['command down', 'shift down'])
await waitForSheet()
const saveButtons = await apple('tell application "System Events" to tell process "OmniCode" to get name of every button of sheet 1 of window 1')
if (!saveButtons.includes('Save')) throw new Error(`Native Save As sheet has no Save button: ${saveButtons}`)
await apple(`tell application "System Events" to tell process "OmniCode" to set value of text field 1 of sheet 1 of window 1 to ${JSON.stringify(savedName)}`)
await apple('tell application "System Events" to tell process "OmniCode" to click button "Save" of sheet 1 of window 1')
await waitFor(
  async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '0',
  'Save As dialog to close'
)
await waitForRenderer(`document.querySelector('.editor-tabs button[title$="/${savedName}"]')?.classList.contains('active')`)
if (await fs.readFile(savedPath, 'utf8') !== saveAsContent) throw new Error('Native Save As did not write exact bytes.')
if (!(await fs.stat(sourcePath)).isFile()) throw new Error('Save As unexpectedly removed its source.')

// Close the saved tab, then reopen the exact saved path through the native Open sheet.
await evaluate(`document.querySelector('.editor-tabs button[title$="/${savedName}"] .tab-close').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true`)
await waitForRenderer(`!document.querySelector('.editor-tabs button[title$="/${savedName}"]')`)
await keystroke('o', ['command down'])
await waitForSheet()
const openButtons = await apple('tell application "System Events" to tell process "OmniCode" to get name of every button of sheet 1 of window 1')
if (!openButtons.includes('Open')) throw new Error(`Native Open sheet has no Open button: ${openButtons}`)
await keystroke('g', ['command down', 'shift down'])
await new Promise((resolve) => setTimeout(resolve, 300))
await keystroke(savedPath)
await keyCode(36)
await new Promise((resolve) => setTimeout(resolve, 500))
await apple('tell application "System Events" to tell process "OmniCode" to click button "Open" of sheet 1 of window 1')
await waitFor(
  async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '0',
  'Open dialog to close'
)
await waitForRenderer(`document.querySelector('.editor-tabs button[title$="/${savedName}"]')?.classList.contains('active')`)
const reopened = await evaluate(`return document.querySelector('.editor-host')?.innerText?.replaceAll(String.fromCharCode(160), ' ').includes('native Save As exact content')`)
if (!reopened) throw new Error('Native Open did not load the saved file content into Monaco.')

await evaluate(`
  document.querySelector('.editor-tabs button[title$="/${savedName}"] .tab-close').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await window.omnicode.workspace.trashEntry(${JSON.stringify(auditRoot)})
  return true
`)
if (await fs.stat(auditRoot).then(() => true, () => false)) throw new Error(`Audit directory was not removed: ${auditRoot}`)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  saveAs: { nativeSheet: true, exactBytes: true, sourcePreserved: true, activePathUpdated: true },
  open: { nativeSheet: true, exactPathSelected: true, MonacoContentVerified: true },
  cleanup: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
