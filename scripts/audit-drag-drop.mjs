import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.argv[2] ?? 9386)
const originalWorkspace = await fs.realpath(process.argv[3] ?? '')

async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 125))
  }
  throw new Error(`Timed out waiting for ${description}.`)
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
async function dispatchFileDrop(targetPath) {
  await evaluate(`
    window.__omnicodeDropAudit = []
    if (!window.__omnicodeDropAuditInstalled) {
      window.__omnicodeDropAuditInstalled = true
      document.addEventListener('drop', (event) => {
        window.__omnicodeDropAudit.push({
          files: [...(event.dataTransfer?.files ?? [])].map((file) => ({ name: file.name, size: file.size, type: file.type })),
          items: [...(event.dataTransfer?.items ?? [])].map((item) => ({ kind: item.kind, type: item.type })),
          types: [...(event.dataTransfer?.types ?? [])]
        })
      }, true)
    }
    return true
  `)
  const point = await evaluate(`
    const rect = document.querySelector('.app-shell').getBoundingClientRect()
    return { x: Math.round(rect.left + 20), y: Math.round(rect.top + 140) }
  `)
  const data = { items: [], files: [targetPath], dragOperationsMask: 1 }
  await call('Input.dispatchDragEvent', { type: 'dragEnter', x: point.x, y: point.y, data })
  await call('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data })
  await call('Input.dispatchDragEvent', { type: 'drop', x: point.x, y: point.y, data })
}

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(originalWorkspace))}`)

// Clear clean tabs left by an interrupted earlier audit before starting.
await evaluate(`
  for (const tab of document.querySelectorAll('.editor-tabs button[title*="/omnicode-drop-audit-"]')) {
    tab.querySelector('.tab-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  return true
`)

const auditRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-drop-audit-'))
await fs.writeFile(path.join(auditRoot, 'External Drop Ω.txt'), 'external drag and drop content\n')
const canonicalRoot = await fs.realpath(auditRoot)
const fileName = 'External Drop Ω.txt'
const filePath = path.join(canonicalRoot, fileName)
const movedName = 'move-me.txt'
const destinationName = 'destination'

await dispatchFileDrop(filePath)
await waitForRenderer(`document.querySelector('.editor-tabs button[title=${JSON.stringify(filePath)}]')?.classList.contains('active')`)
const fileContentLoaded = await evaluate(`return document.querySelector('.editor-host')?.innerText?.replaceAll(String.fromCharCode(160), ' ').includes('external drag and drop content')`)
if (!fileContentLoaded) throw new Error('Dropped file did not load exact content into Monaco.')
const dropDebug = await evaluate(`return window.__omnicodeDropAudit`)
if (!dropDebug.some((event) => event.files.some((file) => file.name === fileName))) {
  throw new Error(`Operating-system drag did not expose its FileList: ${JSON.stringify(dropDebug)}`)
}

await dispatchFileDrop(canonicalRoot)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(canonicalRoot))}`)
const authorized = await evaluate(`try { await window.omnicode.workspace.readTree(${JSON.stringify(canonicalRoot)}); return true } catch { return false }`)
if (!authorized) throw new Error('Dropped directory did not become the authorized workspace.')

// Exercise Explorer's internal draggable rows and directory drop target against disk.
await evaluate(`
  await window.omnicode.workspace.createEntry(${JSON.stringify(canonicalRoot)}, ${JSON.stringify(movedName)}, 'file')
  await window.omnicode.workspace.createEntry(${JSON.stringify(canonicalRoot)}, ${JSON.stringify(destinationName)}, 'directory')
  document.querySelector('button[title="Refresh"]').click()
  return true
`)
await waitForRenderer(`[...document.querySelectorAll('.tree-label')].some((item) => item.textContent === ${JSON.stringify(movedName)}) && [...document.querySelectorAll('.tree-label')].some((item) => item.textContent === ${JSON.stringify(destinationName)})`)
const internalDrop = await evaluate(`
  const row = (name) => [...document.querySelectorAll('.tree-row')].find((item) => item.querySelector('.tree-label')?.textContent === name)
  const source = row(${JSON.stringify(movedName)})
  const destination = row(${JSON.stringify(destinationName)})
  const transfer = new DataTransfer()
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
  destination.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  destination.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  return transfer.getData('application/x-omnicode-path')
`)
if (internalDrop !== path.join(canonicalRoot, movedName)) throw new Error('Explorer dragstart did not encode the exact source path.')
const movedPath = path.join(canonicalRoot, destinationName, movedName)
await waitFor(() => fs.stat(movedPath).then((stats) => stats.isFile(), () => false), 'Explorer drop to move the real file')
if (await fs.stat(path.join(canonicalRoot, movedName)).then(() => true, () => false)) throw new Error('Explorer drop copied instead of moving the source.')

await dispatchFileDrop(originalWorkspace)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(originalWorkspace))}`)

const trashDestination = path.join(os.homedir(), '.Trash', path.basename(canonicalRoot))
await fs.rename(canonicalRoot, trashDestination)
if (await fs.stat(canonicalRoot).then(() => true, () => false)) throw new Error(`Audit directory was not removed: ${canonicalRoot}`)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  externalFile: { operatingSystemDrop: true, exactPathOpened: true, contentLoaded: true },
  externalDirectory: { operatingSystemDrop: true, workspaceAuthorized: true },
  explorerMove: { draggableSource: true, directoryDropTarget: true, diskMoved: true },
  originalWorkspaceRestored: true,
  cleanup: { recoverableTrashPath: trashDestination },
  runtimeErrors: unexpectedErrors
}, null, 2))
