import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9384)
const workspace = await fs.realpath(process.argv[3] ?? '')

async function rendererTarget() {
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
async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`return Boolean(${expression})`).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
async function macShortcut(character) {
  if (!/^[a-z]$/u.test(character)) throw new Error('Refusing an unsupported shortcut.')
  await execFileAsync('/usr/bin/osascript', [
    '-e', 'tell application "OmniCode" to activate',
    '-e', `tell application "System Events" to keystroke ${JSON.stringify(character)} using command down`
  ])
  await new Promise((resolve) => setTimeout(resolve, 250))
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
  await macShortcut('p')
  await waitFor(`document.querySelector('.palette input[placeholder="Search files by name"]')`)
  await setInput('.palette input[placeholder="Search files by name"]', name)
  await waitFor(`[...document.querySelectorAll('.palette-results button strong')].some((item) => item.textContent === ${JSON.stringify(name)})`)
  await evaluate(`
    const strong = [...document.querySelectorAll('.palette-results button strong')].find((item) => item.textContent === ${JSON.stringify(name)})
    strong.closest('button').click()
    return true
  `)
  await waitFor(`document.querySelector('.editor-tabs button[title$="/${name}"]')?.classList.contains('active')`)
}
async function replaceEditorText(name, value) {
  await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
  await macShortcut('a')
  await waitFor(`document.querySelectorAll('.monaco-editor .selected-text').length > 0`)
  await call('Input.insertText', { text: value })
  await waitFor(`document.querySelector('.editor-tabs button[title$="/${name}"] .dirty-dot')`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitFor(`window.omnicode && document.querySelector('.app-shell')`)
await waitFor(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(workspace.split('/').pop())}`)
const exactWorkspaceGranted = await evaluate(`try { await window.omnicode.workspace.readTree(${JSON.stringify(workspace)}); return true } catch { return false }`)
if (!exactWorkspaceGranted) throw new Error(`The expected workspace is not authorized: ${workspace}`)

const auditName = `OmniCode File Lifecycle ${Date.now()}`
const auditRoot = `${workspace}/${auditName}`
const paths = {
  autosave: `${auditRoot}/autosave.txt`,
  externalClean: `${auditRoot}/external-clean.txt`,
  externalDirty: `${auditRoot}/external-dirty.txt`,
  externalDelete: `${auditRoot}/external-delete.txt`,
  readOnly: `${auditRoot}/read-only/permission.txt`
}
const originalAutosave = await evaluate(`return localStorage.getItem('omnicode.autosave')`)
await evaluate(`
  const root = await window.omnicode.workspace.createEntry(${JSON.stringify(workspace)}, ${JSON.stringify(auditName)}, 'directory')
  for (const name of ['autosave.txt', 'external-clean.txt', 'external-dirty.txt', 'external-delete.txt']) {
    const path = await window.omnicode.workspace.createEntry(root, name, 'file')
    await window.omnicode.workspace.writeFile(path, name + ${JSON.stringify(' baseline\n')})
  }
  const readOnly = await window.omnicode.workspace.createEntry(root, 'read-only', 'directory')
  const permission = await window.omnicode.workspace.createEntry(readOnly, 'permission.txt', 'file')
  await window.omnicode.workspace.writeFile(permission, ${JSON.stringify('permission baseline\n')})
  return true
`)

// Turn on the real Autosave preference, edit in Monaco, and observe the delayed disk write.
await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
await waitFor(`document.querySelector('.settings-panel #files input[type="checkbox"]')`)
await evaluate(`
  const input = document.querySelector('.settings-panel #files input[type="checkbox"]')
  if (!input.checked) input.click()
  document.querySelector('.settings-panel header button[title="Close settings"]').click()
  return true
`)
await openByQuickOpen('autosave.txt')
const autosavedText = `autosaved through OmniCode ${Date.now()}\n`
await replaceEditorText('autosave.txt', autosavedText)
await waitFor(`!document.querySelector('.editor-tabs button[title$="/autosave.txt"] .dirty-dot')`, 8_000)
if (await fs.readFile(paths.autosave, 'utf8') !== autosavedText) throw new Error('Autosave cleared dirty state without writing exact disk bytes.')

// A clean open document must reload an external write.
await openByQuickOpen('external-clean.txt')
await new Promise((resolve) => setTimeout(resolve, 25))
const externalCleanText = `external clean revision ${Date.now()}\n`
await fs.writeFile(paths.externalClean, externalCleanText)
await waitFor(`document.querySelector('.toast')?.textContent?.includes('Reloaded external-clean.txt')`)
await waitFor(`document.querySelector('.editor-host')?.innerText?.replaceAll(String.fromCharCode(160), ' ').includes('external clean revision')`)
if (await evaluate(`return Boolean(document.querySelector('.editor-tabs button[title$="/external-clean.txt"] .dirty-dot'))`)) throw new Error('A clean external reload became dirty.')

// A clean externally deleted file must close rather than leave a phantom tab.
await openByQuickOpen('external-delete.txt')
await fs.unlink(paths.externalDelete)
await waitFor(`!document.querySelector('.editor-tabs button[title$="/external-delete.txt"]')`)
await waitFor(`document.querySelector('.toast')?.textContent?.includes('Closed external-delete.txt')`)

// A dirty document must preserve local edits and refuse to overwrite an external revision.
await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
await waitFor(`document.querySelector('.settings-panel #files input[type="checkbox"]')`)
await evaluate(`
  const input = document.querySelector('.settings-panel #files input[type="checkbox"]')
  if (input.checked) input.click()
  document.querySelector('.settings-panel header button[title="Close settings"]').click()
  return true
`)
await openByQuickOpen('external-dirty.txt')
const localUnsaved = `local unsaved version ${Date.now()}\n`
await replaceEditorText('external-dirty.txt', localUnsaved)
await new Promise((resolve) => setTimeout(resolve, 25))
const externalDirtyText = `external competing version ${Date.now()}\n`
await fs.writeFile(paths.externalDirty, externalDirtyText)
await waitFor(`document.querySelector('.toast')?.textContent?.includes('Save is paused until you review the conflict')`)
await macShortcut('s')
await waitFor(`document.querySelector('.toast')?.textContent?.includes('This file changed on disk after it was opened')`)
if (await fs.readFile(paths.externalDirty, 'utf8') !== externalDirtyText) throw new Error('Conflict Save overwrote the external revision.')
if (!(await evaluate(`return Boolean(document.querySelector('.editor-tabs button[title$="/external-dirty.txt"] .dirty-dot'))`))) throw new Error('Conflict Save incorrectly cleared dirty state.')

// Rejecting and accepting the existing unsaved-tab prompt must leave/delete the tab respectively.
const promptBehavior = await evaluate(`
  const tab = document.querySelector('.editor-tabs button[title$="/external-dirty.txt"]')
  const close = tab.querySelector('.tab-close')
  const original = window.confirm
  window.confirm = () => false
  close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const retained = Boolean(document.querySelector('.editor-tabs button[title$="/external-dirty.txt"]'))
  window.confirm = () => true
  close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  window.confirm = original
  return { retained }
`)
await waitFor(`!document.querySelector('.editor-tabs button[title$="/external-dirty.txt"]')`)
if (!promptBehavior.retained) throw new Error('Rejecting the unsaved-close prompt still closed the tab.')

// A directory permission failure must be accurate, preserve disk, and retain dirty state.
await fs.chmod(`${auditRoot}/read-only`, 0o555)
await openByQuickOpen('permission.txt')
const deniedWrite = `must not replace disk ${Date.now()}\n`
await replaceEditorText('permission.txt', deniedWrite)
await macShortcut('s')
await waitFor(`/permission denied|EACCES/iu.test(document.querySelector('.toast')?.textContent || '')`)
if (await fs.readFile(paths.readOnly, 'utf8') !== 'permission baseline\n') throw new Error('Permission-denied Save changed disk.')
if (!(await evaluate(`return Boolean(document.querySelector('.editor-tabs button[title$="/permission.txt"] .dirty-dot'))`))) throw new Error('Permission-denied Save cleared dirty state.')
await fs.chmod(`${auditRoot}/read-only`, 0o755)
await evaluate(`
  const tab = document.querySelector('.editor-tabs button[title$="/permission.txt"]')
  const original = window.confirm
  window.confirm = () => true
  tab.querySelector('.tab-close').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  window.confirm = original
  return true
`)
await waitFor(`!document.querySelector('.editor-tabs button[title$="/permission.txt"]')`)

// Restore the user's isolated-profile Autosave value and remove the disposable fixture.
const originalEnabled = originalAutosave === 'true'
await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
await waitFor(`document.querySelector('.settings-panel #files input[type="checkbox"]')`)
await evaluate(`
  const input = document.querySelector('.settings-panel #files input[type="checkbox"]')
  if (input.checked !== ${originalEnabled}) input.click()
  document.querySelector('.settings-panel header button[title="Close settings"]').click()
  if (${JSON.stringify(originalAutosave)} === null) localStorage.removeItem('omnicode.autosave')
  else localStorage.setItem('omnicode.autosave', ${JSON.stringify(originalAutosave)})
  await window.omnicode.workspace.trashEntry(${JSON.stringify(auditRoot)})
  return true
`)
if (await fs.stat(auditRoot).then(() => true, () => false)) throw new Error(`Audit directory was not removed: ${auditRoot}`)

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  autosave: { delayedWrite: true, exactBytes: true },
  externalChanges: { cleanReload: true, cleanDeleteClosed: true, dirtyConflictPreserved: true },
  unsavedTabPrompt: { rejectRetained: true, acceptClosed: true },
  permissionDenied: { usefulError: true, diskPreserved: true, dirtyPreserved: true },
  preferencesRestored: true,
  cleanup: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
