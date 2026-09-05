import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9350)
let workspace = process.argv[3]
if (!workspace) throw new Error('Usage: node scripts/audit-files-editor.mjs <debug-port> <workspace>')
workspace = await fs.realpath(workspace)

async function targetWhenReady() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const target = await fetch(`http://127.0.0.1:${port}/json`)
      .then((response) => response.json())
      .then((targets) => targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl))
      .catch(() => undefined)
    if (target) return target
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`No renderer target appeared on port ${port}.`)
}

const target = await targetWhenReady()
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
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
    runtimeErrors.push(message.params.entry.text)
  }
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
  if (response.exceptionDetails) {
    throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\nExpression:\n${body}`)
  }
  return response.result.value
}
async function waitFor(expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`return Boolean(${expression})`).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
async function shortcut(key, code, modifiers = 4, commands) {
  const common = { modifiers, key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) }
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common, ...(commands ? { commands } : {}) })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

await call('Runtime.enable')
await call('Log.enable')
await call('Page.enable')
await waitFor(`window.omnicode && document.querySelector('.app-shell')`)

const root = JSON.stringify(workspace)
const auditName = `OmniCode Audit ${Date.now()}`
const filesystem = await evaluate(`
  const workspaceRoot = ${root}
  const root = await window.omnicode.workspace.createEntry(workspaceRoot, ${JSON.stringify(auditName)}, 'directory')
  const nested = await window.omnicode.workspace.createEntry(root, 'Nested Folder', 'directory')
  const destination = await window.omnicode.workspace.createEntry(root, 'Move-To', 'directory')
  const unicodeFile = await window.omnicode.workspace.createEntry(nested, 'Résumé_测试-file.txt', 'file')
  const written = await window.omnicode.workspace.writeFile(unicodeFile, 'alpha unique phrase omega\\n')
  const renamed = await window.omnicode.workspace.renameEntry(written.path, 'Renamed file.with.periods.txt')
  const moved = await window.omnicode.workspace.moveEntry(renamed, destination)
  const duplicate = await window.omnicode.workspace.duplicateEntry(moved)
  const searches = await window.omnicode.workspace.search(root, 'unique phrase', { caseSensitive: true })
  const replaced = await window.omnicode.workspace.replaceAll(root, 'unique phrase', 'verified replacement', { caseSensitive: true })
  let outsideRejected = false
  try { await window.omnicode.workspace.readFile('/etc/passwd') } catch (error) { outsideRejected = /outside|workspace/i.test(String(error)) }
  const trash = await window.omnicode.workspace.createEntry(root, 'trash-me-audit.txt', 'file')
  await window.omnicode.workspace.trashEntry(trash)
  const tree = await window.omnicode.workspace.readTree(root)
  return { auditRoot: root, nested, destination, moved, duplicate, searches, replaced, outsideRejected,
    trashRemoved: !tree.some((item) => item.name === 'trash-me-audit.txt'), tree }
`)
const binaryPath = `${filesystem.auditRoot}/binary.dat`
await fs.writeFile(binaryPath, Buffer.from([0x62, 0x65, 0x66, 0x6f, 0x72, 0x65, 0x00, 0x61, 0x66, 0x74, 0x65, 0x72]))
const binaryRejected = await evaluate(`
  try { await window.omnicode.workspace.readFile(${JSON.stringify(binaryPath)}); return false }
  catch (error) { return /binary/i.test(String(error)) }
`)
if (!binaryRejected || !filesystem.outsideRejected || !filesystem.trashRemoved || filesystem.searches.length !== 2 || filesystem.replaced.replacements !== 2) {
  throw new Error(`Filesystem integration failed: ${JSON.stringify(filesystem)}`)
}
if (await fs.readFile(filesystem.moved, 'utf8') !== 'alpha verified replacement omega\n' ||
    await fs.readFile(filesystem.duplicate, 'utf8') !== 'alpha verified replacement omega\n') {
  throw new Error('Move, duplicate, or replacement did not match the real filesystem.')
}

await evaluate(`
  const row = [...document.querySelectorAll('.tree-row')].find((item) => item.querySelector('.tree-label')?.textContent === 'main.ts')
  if (!row) throw new Error('main.ts is missing from Explorer.')
  row.click()
  return true
`)
await waitFor(`document.querySelector('.monaco-editor .native-edit-context') && document.querySelector('.editor-tabs button[title$="/main.ts"]')`)
await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
await shortcut('a', 'KeyA')
const editorText = `const edited: string = 'saved through OmniCode ${Date.now()}'\nconsole.log(edited)\n`
await call('Input.insertText', { text: editorText.slice(0, -1) })
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await waitFor(`document.querySelector('.editor-tabs button[title$="/main.ts"] .dirty-dot')`)
const dirtyBeforeSave = await evaluate(`return Boolean(document.querySelector('.editor-tabs button[title$="/main.ts"] .dirty-dot'))`)
await evaluate(`document.querySelector('.breadcrumbs button[title="Save"]').click(); return true`)
await waitFor(`!document.querySelector('.editor-tabs button[title$="/main.ts"] .dirty-dot')`)
const savedText = await fs.readFile(`${workspace}/main.ts`, 'utf8')
if (savedText !== editorText) throw new Error(`Editor save mismatch: ${JSON.stringify(savedText)}`)

await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
await shortcut('f', 'KeyF')
await waitFor(`document.querySelector('.find-widget')?.classList.contains('visible')`)
const findOpened = await evaluate(`return document.querySelector('.find-widget')?.classList.contains('visible')`)
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
await waitFor(`document.querySelector('.settings-overlay')`)
const settingsOpened = true
await evaluate(`document.querySelector('.settings-panel header button[title="Close settings"]').click(); return true`)

await evaluate(`document.querySelector('.editor-tabs button[title$="/main.ts"] .tab-close').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true`)
await waitFor(`!document.querySelector('.editor-tabs button[title$="/main.ts"]')`)
const tabClosedViaUi = true

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/i.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
await evaluate(`await window.omnicode.workspace.trashEntry(${JSON.stringify(filesystem.auditRoot)}); return true`)
if (await fs.stat(filesystem.auditRoot).then(() => true, () => false)) {
  throw new Error(`Audit directory was not removed from the workspace: ${filesystem.auditRoot}`)
}
socket.close()
console.log(JSON.stringify({
  filesystem: {
    unicodeAndNested: true, rename: true, move: true, duplicate: true,
    searchMatches: filesystem.searches.length, replacements: filesystem.replaced.replacements,
    binaryRejected, outsideRejected: filesystem.outsideRejected,
    trashRemoved: filesystem.trashRemoved
  },
  editor: { dirtyBeforeSave, saved: true, findShortcutOpened: findOpened, settingsOpened, tabClosedViaUi },
  runtimeErrors: unexpectedErrors
}, null, 2))
