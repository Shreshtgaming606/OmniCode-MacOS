import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9390)
const originalWorkspace = await fs.realpath(process.argv[3] ?? '')

async function apple(...expressions) {
  const args = expressions.flatMap((expression) => ['-e', expression])
  return (await execFileAsync('/usr/bin/osascript', args, { timeout: 5_000 })).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function frontmost() {
  await apple('tell application "OmniCode" to reopen', 'tell application "OmniCode" to activate')
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to get frontmost')) === 'true',
    'OmniCode to become frontmost'
  )
}
async function openFolderSheet() {
  await frontmost()
  await apple(
    'tell application "System Events" to tell process "OmniCode" to click menu bar item "File" of menu bar 1',
    'tell application "System Events" to tell process "OmniCode" to click menu item "Open Folder…" of menu 1 of menu bar item "File" of menu bar 1'
  )
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '1',
    'native folder sheet'
  )
  const buttons = await apple('tell application "System Events" to tell process "OmniCode" to get name of every button of sheet 1 of window 1')
  if (!buttons.includes('Open') || !buttons.includes('Cancel')) throw new Error(`Folder sheet buttons were incomplete: ${buttons}`)
  return buttons
}
async function chooseFolder(folder) {
  const parent = path.dirname(folder)
  const name = path.basename(folder)
  await apple('tell application "System Events" to keystroke "g" using {command down, shift down}')
  await new Promise((resolve) => setTimeout(resolve, 250))
  // A directory path navigates inside that directory. Navigate to its parent,
  // then select the directory row so Open chooses the directory itself.
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(parent)}`)
  await apple('tell application "System Events" to key code 36')
  await new Promise((resolve) => setTimeout(resolve, 700))
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(name)}`)
  await new Promise((resolve) => setTimeout(resolve, 350))
  await apple('tell application "System Events" to tell process "OmniCode" to click button "Open" of sheet 1 of window 1')
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '0',
    'folder sheet to close'
  )
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
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}
async function waitForWorkspace(workspace) {
  await waitFor(
    async () => await evaluate(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(workspace)}`),
    `workspace ${workspace}`
  )
}

await call('Runtime.enable')
await call('Log.enable')
await waitForWorkspace(originalWorkspace)
const testWorkspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-folder-picker-')))
await fs.writeFile(path.join(testWorkspace, 'folder-picker-marker.txt'), 'native folder picker\n')
let currentWorkspace = originalWorkspace

try {
  const openButtons = await openFolderSheet()
  await chooseFolder(testWorkspace)
  await waitForWorkspace(testWorkspace)
  currentWorkspace = testWorkspace
  const tree = await evaluate(`window.omnicode.workspace.readTree(${JSON.stringify(testWorkspace)})`)
  if (!tree.some((item) => item.name === 'folder-picker-marker.txt')) throw new Error('The selected folder was not opened as the real workspace.')

  const cancelButtons = await openFolderSheet()
  await apple('tell application "System Events" to tell process "OmniCode" to click button "Cancel" of sheet 1 of window 1')
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '0',
    'cancelled folder sheet to close'
  )
  await waitForWorkspace(testWorkspace)

  await openFolderSheet()
  await chooseFolder(originalWorkspace)
  await waitForWorkspace(originalWorkspace)
  currentWorkspace = originalWorkspace

  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  console.log(JSON.stringify({
    open: { nativeSheet: true, buttons: openButtons, selectedExactFolder: true, workspaceAuthorized: true },
    cancel: { nativeSheet: true, buttons: cancelButtons, workspaceUnchanged: true },
    restore: { nativeSheet: true, originalWorkspace: true },
    cleanup: { fixtureRemoved: true },
    runtimeErrors: unexpectedErrors
  }, null, 2))
} finally {
  if (currentWorkspace !== originalWorkspace) {
    await openFolderSheet().then(() => chooseFolder(originalWorkspace)).catch(() => undefined)
    await waitForWorkspace(originalWorkspace).catch(() => undefined)
  }
  await fs.rm(testWorkspace, { recursive: true, force: true })
  socket.close()
}
