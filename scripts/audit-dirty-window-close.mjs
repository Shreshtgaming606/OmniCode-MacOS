import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const workspace = await fs.realpath(process.argv[3] ?? '')
const appPath = path.resolve(process.argv[4] ?? 'dist/mac/OmniCode.app')

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
async function targets() {
  return fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
}
async function macShortcut(character) {
  if (!/^[a-z]$/u.test(character)) throw new Error('Refusing an unsupported shortcut.')
  await apple('tell application "OmniCode" to activate')
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to get frontmost')) === 'true',
    'OmniCode to become frontmost'
  )
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(character)} using command down`)
  await new Promise((resolve) => setTimeout(resolve, 250))
}
async function windowCount() {
  return Number(await apple('tell application "System Events" to tell process "OmniCode" to count windows'))
}
async function closeWindow() {
  await apple('tell application "System Events" to tell process "OmniCode" to click (first button of window 1 whose description is "close button")')
}
async function waitForSheet() {
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '1',
    'native unsaved-changes sheet'
  )
  const buttons = await apple('tell application "System Events" to tell process "OmniCode" to get name of every button of sheet 1 of window 1')
  for (const expected of ['Save All', 'Discard Changes', 'Cancel']) {
    if (!buttons.includes(expected)) throw new Error(`Native sheet is missing ${expected}: ${buttons}`)
  }
}
async function clickSheetButton(name) {
  await apple(`tell application "System Events" to tell process "OmniCode" to click button ${JSON.stringify(name)} of sheet 1 of window 1`)
}

class RendererConnection {
  constructor(socket) {
    this.socket = socket
    this.pending = new Map()
    this.runtimeErrors = []
    this.nextId = 1
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data))
      if (message.id) {
        const operation = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) operation?.reject(new Error(message.error.message))
        else operation?.resolve(message.result)
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'Runtime exception')
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') this.runtimeErrors.push(message.params.entry.text)
    })
  }

  call(method, params = {}) {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async evaluate(body) {
    const response = await this.call('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
    })
    if (response.exceptionDetails) throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\nExpression:\n${body}`)
    return response.result.value
  }

  async waitFor(expression, timeoutMs = 20_000) {
    await waitFor(
      async () => Boolean(await this.evaluate(`return Boolean(${expression})`).catch(() => false)),
      expression,
      timeoutMs
    )
  }

  close() {
    this.socket.close()
  }
}

async function connect() {
  let target
  await waitFor(async () => {
    target = (await targets()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    return Boolean(target)
  }, 'packaged renderer target', 30_000)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const renderer = new RendererConnection(socket)
  await renderer.call('Runtime.enable')
  await renderer.call('Log.enable')
  await renderer.waitFor(`window.omnicode && document.querySelector('.app-shell')`)
  await renderer.waitFor(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(workspace.split('/').pop())}`)
  return renderer
}
async function setInput(renderer, selector, value) {
  await renderer.evaluate(`
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('Missing input: ' + ${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
}
async function openByQuickOpen(renderer, name) {
  await macShortcut('p')
  await renderer.waitFor(`document.querySelector('.palette input[placeholder="Search files by name"]')`)
  await setInput(renderer, '.palette input[placeholder="Search files by name"]', name)
  await renderer.waitFor(`[...document.querySelectorAll('.palette-results button strong')].some((item) => item.textContent === ${JSON.stringify(name)})`)
  await renderer.evaluate(`
    const strong = [...document.querySelectorAll('.palette-results button strong')].find((item) => item.textContent === ${JSON.stringify(name)})
    strong.closest('button').click()
    return true
  `)
  await renderer.waitFor(`document.querySelector('.editor-tabs button[title$="/${name}"]')?.classList.contains('active')`)
}
async function replaceEditorText(renderer, name, value) {
  await renderer.evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
  await macShortcut('a')
  await renderer.waitFor(`document.querySelectorAll('.monaco-editor .selected-text').length > 0`)
  await renderer.call('Input.insertText', { text: value })
  await renderer.waitFor(`document.querySelector('.editor-tabs button[title$="/${name}"] .dirty-dot')`)
}
async function reopen() {
  await execFileAsync('/usr/bin/open', ['-a', appPath])
  await waitFor(async () => (await windowCount()) === 1, 'window reopen')
  return connect()
}

let renderer = await connect()
const auditName = `OmniCode Dirty Close ${Date.now()}`
const auditRoot = `${workspace}/${auditName}`
const fileName = 'unsaved.txt'
const filePath = `${auditRoot}/${fileName}`
const baseline = 'disk baseline\n'
const originalAutosave = await renderer.evaluate(`return localStorage.getItem('omnicode.autosave')`)

// Autosave must be disabled so the native dirty-close choices remain observable.
await renderer.evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
await renderer.waitFor(`document.querySelector('.settings-panel #files input[type="checkbox"]')`)
await renderer.evaluate(`
  const input = document.querySelector('.settings-panel #files input[type="checkbox"]')
  if (input.checked) input.click()
  document.querySelector('.settings-panel header button[title="Close settings"]').click()
  const root = await window.omnicode.workspace.createEntry(${JSON.stringify(workspace)}, ${JSON.stringify(auditName)}, 'directory')
  const file = await window.omnicode.workspace.createEntry(root, ${JSON.stringify(fileName)}, 'file')
  await window.omnicode.workspace.writeFile(file, ${JSON.stringify(baseline)})
  return true
`)
await openByQuickOpen(renderer, fileName)

const cancelledText = `cancel retains this edit ${Date.now()}\n`
await replaceEditorText(renderer, fileName, cancelledText)
await closeWindow()
await waitForSheet()
await clickSheetButton('Cancel')
await waitFor(async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '0', 'Cancel to dismiss sheet')
if ((await windowCount()) !== 1) throw new Error('Cancel closed the native window.')
if (!(await renderer.evaluate(`return Boolean(document.querySelector('.editor-tabs button[title$="/${fileName}"] .dirty-dot'))`))) throw new Error('Cancel lost the dirty buffer.')
if (await fs.readFile(filePath, 'utf8') !== baseline) throw new Error('Cancel changed the file on disk.')

await closeWindow()
await waitForSheet()
await clickSheetButton('Discard Changes')
await waitFor(async () => (await windowCount()) === 0, 'Discard Changes to close window')
await waitFor(async () => !(await targets()).some((target) => target.type === 'page'), 'renderer teardown after discard')
if (await fs.readFile(filePath, 'utf8') !== baseline) throw new Error('Discard Changes wrote the dirty buffer.')
renderer.close()

renderer = await reopen()
await openByQuickOpen(renderer, fileName)
const savedText = `save all writes exact bytes ${Date.now()}\n`
await replaceEditorText(renderer, fileName, savedText)
await closeWindow()
await waitForSheet()
await clickSheetButton('Save All')
await waitFor(async () => (await windowCount()) === 0, 'Save All to close window')
await waitFor(async () => !(await targets()).some((target) => target.type === 'page'), 'renderer teardown after save')
if (await fs.readFile(filePath, 'utf8') !== savedText) throw new Error('Save All closed without writing exact disk bytes.')
renderer.close()

renderer = await reopen()
await renderer.evaluate(`
  document.querySelector('button[title="Settings"]').click()
  return true
`)
await renderer.waitFor(`document.querySelector('.settings-panel #files input[type="checkbox"]')`)
const originalEnabled = originalAutosave === 'true'
await renderer.evaluate(`
  const input = document.querySelector('.settings-panel #files input[type="checkbox"]')
  if (input.checked !== ${originalEnabled}) input.click()
  document.querySelector('.settings-panel header button[title="Close settings"]').click()
  if (${JSON.stringify(originalAutosave)} === null) localStorage.removeItem('omnicode.autosave')
  else localStorage.setItem('omnicode.autosave', ${JSON.stringify(originalAutosave)})
  await window.omnicode.workspace.trashEntry(${JSON.stringify(auditRoot)})
  return true
`)
if (await fs.stat(auditRoot).then(() => true, () => false)) throw new Error(`Audit directory was not removed: ${auditRoot}`)

const unexpectedErrors = renderer.runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
renderer.close()
console.log(JSON.stringify({
  nativeSheet: { buttons: ['Save All', 'Discard Changes', 'Cancel'] },
  cancel: { windowRetained: true, dirtyRetained: true, diskPreserved: true },
  discard: { windowClosed: true, diskPreserved: true },
  saveAll: { exactBytesWritten: true, windowClosed: true },
  reopenedAfterEachClose: true,
  preferencesRestored: true,
  cleanup: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
