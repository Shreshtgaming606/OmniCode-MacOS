import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9398)
const workspace = await fs.realpath(process.argv[3] ?? '')

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
}, 'packaged renderer target', 30_000)

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const runtimeErrors = []
const confirmations = []
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
  if (message.method === 'Page.javascriptDialogOpening') {
    confirmations.push(message.params.message)
    void call('Page.handleJavaScriptDialog', { accept: true }).catch((error) => runtimeErrors.push(String(error)))
  }
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
async function waitForRenderer(expression, description = expression, timeoutMs = 20_000) {
  await waitFor(async () => Boolean(await evaluate(`return Boolean(${expression})`).catch(() => false)), description, timeoutMs)
}
async function exists(targetPath) {
  return fs.lstat(targetPath).then(() => true, () => false)
}
async function openContextAction(name, action) {
  await evaluate(`
    const row = [...document.querySelectorAll('.tree-row')].find((item) => item.querySelector('.tree-label')?.textContent === ${JSON.stringify(name)})
    if (!row) throw new Error('Missing Explorer row for ' + ${JSON.stringify(name)})
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 180 }))
    return true
  `)
  await waitForRenderer(`[...document.querySelectorAll('.context-menu button')].some((item) => item.textContent?.includes(${JSON.stringify(action)}))`, `${action} context action`)
  await evaluate(`
    [...document.querySelectorAll('.context-menu button')].find((item) => item.textContent?.includes(${JSON.stringify(action)})).click()
    return true
  `)
}
async function submitInput(title, value) {
  await waitForRenderer(`document.querySelector('.input-modal')?.getAttribute('aria-label') === ${JSON.stringify(title)}`, `${title} input dialog`)
  await evaluate(`
    const form = document.querySelector('.input-modal')
    const input = form.querySelector('input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    form.requestSubmit()
    return true
  `)
  await waitForRenderer(`!document.querySelector('.input-modal')`, `${title} dialog to close`)
}
async function expandDirectory(name) {
  await evaluate(`
    const row = [...document.querySelectorAll('.tree-row')].find((item) => item.querySelector('.tree-label')?.textContent === ${JSON.stringify(name)})
    if (!row) throw new Error('Missing directory row for ' + ${JSON.stringify(name)})
    row.click()
    return true
  `)
}

await call('Runtime.enable')
await call('Log.enable')
await call('Page.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`, 'workbench')
await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(workspace)}`, 'expected workspace')

const suffix = Date.now()
const parentName = `Explorer Controls ${suffix}`
const folderName = 'Created Folder Ω'
const fileName = 'Created File Ω.test.txt'
const renamedName = 'Renamed File Ω.test.txt'
const duplicateName = 'Renamed File Ω.test copy.txt'
const parentPath = `${workspace}/${parentName}`
const folderPath = `${parentPath}/${folderName}`
const filePath = `${parentPath}/${fileName}`
const renamedPath = `${parentPath}/${renamedName}`
const duplicatePath = `${parentPath}/${duplicateName}`
const content = `Explorer context lifecycle ${suffix}\n`

try {
  await evaluate(`
    await window.omnicode.workspace.createEntry(${JSON.stringify(workspace)}, ${JSON.stringify(parentName)}, 'directory')
    document.querySelector('button[aria-label="Refresh explorer"]').click()
    return true
  `)
  await waitForRenderer(`[...document.querySelectorAll('.tree-label')].some((item) => item.textContent === ${JSON.stringify(parentName)})`, 'parent directory row')

  await openContextAction(parentName, 'New Folder')
  await submitInput('New Folder', folderName)
  await waitFor(() => exists(folderPath), 'created folder on disk')

  await openContextAction(parentName, 'New File')
  await submitInput('New File', fileName)
  await waitFor(() => exists(filePath), 'created file on disk')
  await waitForRenderer(`document.querySelector('.editor-tabs button[title=${JSON.stringify(filePath)}]')`, 'created file editor tab')
  await evaluate(`await window.omnicode.workspace.writeFile(${JSON.stringify(filePath)}, ${JSON.stringify(content)}); return true`)
  await expandDirectory(parentName)
  await waitForRenderer(`[...document.querySelectorAll('.tree-label')].some((item) => item.textContent === ${JSON.stringify(fileName)})`, 'created file Explorer row')
  await waitForRenderer(`[...document.querySelectorAll('.tree-label')].some((item) => item.textContent === ${JSON.stringify(folderName)})`, 'created folder Explorer row')

  await openContextAction(fileName, 'Rename')
  await submitInput(`Rename ${fileName}`, renamedName)
  await waitFor(async () => await exists(renamedPath) && !(await exists(filePath)), 'renamed file on disk')
  await waitForRenderer(`document.querySelector('.editor-tabs button[title=${JSON.stringify(renamedPath)}]')`, 'renamed editor tab')

  await openContextAction(renamedName, 'Duplicate')
  await waitFor(() => exists(duplicatePath), 'duplicated file on disk')
  if (await fs.readFile(duplicatePath, 'utf8') !== content) throw new Error('Duplicated file content did not match the real source bytes.')
  await waitForRenderer(`[...document.querySelectorAll('.tree-label')].some((item) => item.textContent === ${JSON.stringify(duplicateName)})`, 'duplicated Explorer row')

  await openContextAction(duplicateName, 'Move to Trash')
  await waitFor(async () => !(await exists(duplicatePath)), 'duplicate to move to Trash')
  await openContextAction(folderName, 'Move to Trash')
  await waitFor(async () => !(await exists(folderPath)), 'created folder to move to Trash')
  await openContextAction(renamedName, 'Move to Trash')
  await waitFor(async () => !(await exists(renamedPath)), 'renamed file to move to Trash')
  await openContextAction(parentName, 'Move to Trash')
  await waitFor(async () => !(await exists(parentPath)), 'parent directory to move to Trash')

  if (confirmations.length !== 4 || confirmations.some((message) => !message.startsWith('Move “'))) {
    throw new Error(`Unexpected native confirmation flow: ${JSON.stringify(confirmations)}`)
  }
  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  console.log(JSON.stringify({
    contextMenu: { newFolder: true, newFile: true, rename: true, duplicate: true, trash: true },
    paths: { spaces: true, unicode: true, periods: true },
    filesystem: { exactCreate: true, exactRename: true, duplicateBytes: true, removedAfterTrash: true },
    dialogs: { styledInputs: 3, nativeConfirmations: confirmations.length },
    cleanup: true,
    runtimeErrors: unexpectedErrors
  }, null, 2))
} finally {
  if (await exists(parentPath)) await evaluate(`await window.omnicode.workspace.trashEntry(${JSON.stringify(parentPath)}); return true`).catch(() => undefined)
  socket.close()
}
