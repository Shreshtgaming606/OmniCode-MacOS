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
async function waitFor(check, description, timeoutMs = 30_000) {
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
async function waitForRenderer(expression, timeoutMs = 30_000) {
  await waitFor(async () => Boolean(await evaluate(`return Boolean(${expression})`).catch(() => false)), expression, timeoutMs)
}
async function dispatchDirectoryDrop(directory) {
  const point = await evaluate(`
    const rect = document.querySelector('.app-shell').getBoundingClientRect()
    return { x: Math.round(rect.left + 20), y: Math.round(rect.top + 140) }
  `)
  const data = { items: [], files: [directory], dragOperationsMask: 1 }
  await call('Input.dispatchDragEvent', { type: 'dragEnter', x: point.x, y: point.y, data })
  await call('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data })
  await call('Input.dispatchDragEvent', { type: 'drop', x: point.x, y: point.y, data })
}
function sessionIdFromTabId(tabId) {
  return tabId.replace(/^omnicode-terminal-/u, '').replace(/-tab$/u, '')
}
async function activeSession() {
  return evaluate(`
    const tab = document.querySelector('.terminal-panel__tab.is-active')
    return tab ? { id: tab.id, title: tab.title } : null
  `)
}
async function showTerminal() {
  await evaluate(`
    const terminalTab = [...document.querySelectorAll('.panel-tabs button')].find((button) => button.textContent?.startsWith('terminal'))
    if (!document.querySelector('.bottom-panel') || getComputedStyle(document.querySelector('.bottom-panel')).display === 'none') {
      document.querySelector('button[title="Bottom panel"]').click()
    }
    terminalTab?.click()
    return true
  `)
  await waitForRenderer(`document.querySelector('.terminal-panel')?.hidden === false`)
  await waitForRenderer(`document.querySelector('.terminal-panel__tab.is-active')`)
}
async function openByQuickOpen(name) {
  await apple('tell application "OmniCode" to activate')
  await apple('tell application "System Events" to keystroke "p" using command down')
  await waitForRenderer(`document.querySelector('.palette input[placeholder="Search files by name"]')`)
  await evaluate(`
    const input = document.querySelector('.palette input[placeholder="Search files by name"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
  await waitForRenderer(`[...document.querySelectorAll('.palette-results button strong')].some((item) => item.textContent === ${JSON.stringify(name)})`)
  await evaluate(`
    [...document.querySelectorAll('.palette-results button strong')].find((item) => item.textContent === ${JSON.stringify(name)}).closest('button').click()
    return true
  `)
  await waitForRenderer(`document.querySelector('.editor-tabs button[title$="/${name}"]')?.classList.contains('active')`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)
await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(originalWorkspace)}`)

const testWorkspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-workspace-switch-')))
const movedWorkspace = `${testWorkspace}-moved`
const fixtureName = 'move-test.txt'
const fixturePath = path.join(testWorkspace, fixtureName)
const movedFixturePath = path.join(movedWorkspace, fixtureName)
const baseline = 'WORKSPACE_MOVE_BASELINE\n'
const dirtyText = 'WORKSPACE_MOVE_DIRTY_BUFFER'
await fs.writeFile(fixturePath, baseline)
let renamed = false
let originalConfirm = null

try {
  await showTerminal()
  const original = await activeSession()
  const originalId = sessionIdFromTabId(original.id)

  await dispatchDirectoryDrop(testWorkspace)
  await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(testWorkspace)}`)
  await showTerminal()
  await waitFor(async () => (await activeSession())?.title.endsWith(` — ${testWorkspace}`), 'new workspace terminal')
  const switched = await activeSession()
  const switchedId = sessionIdFromTabId(switched.id)
  if (switchedId === originalId) throw new Error('Workspace switch reused the previous PTY session.')

  const terminalMarker = `WORKSPACE_CWD_${process.pid}`
  await evaluate(`
    window.omnicode.terminal.write(${JSON.stringify(switchedId)}, ${JSON.stringify(`printf '${terminalMarker}\\n'; pwd\r`)})
    return true
  `)
  await waitForRenderer(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes(${JSON.stringify(terminalMarker)})`)
  await waitForRenderer(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes(${JSON.stringify(testWorkspace)})`)
  const terminalText = await evaluate(`return document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent ?? ''`)
  if (!terminalText.includes(testWorkspace)) throw new Error(`Switched terminal did not print its workspace cwd: ${terminalText}`)
  await evaluate(`
    window.omnicode.terminal.write(${JSON.stringify(originalId)}, ${JSON.stringify("printf 'STALE_TERMINAL_SHOULD_NOT_RUN\\n'\r")})
    return true
  `)
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (await evaluate(`return document.querySelector('.terminal-panel__viewport')?.textContent.includes('STALE_TERMINAL_SHOULD_NOT_RUN')`)) {
    throw new Error('The previous workspace PTY was still connected after switching.')
  }

  await openByQuickOpen(fixtureName)
  await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
  await apple('tell application "OmniCode" to activate')
  await apple('tell application "System Events" to keystroke "a" using command down')
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(dirtyText)}`)
  await waitForRenderer(`document.querySelector('.editor-tabs button[title$="/${fixtureName}"] .dirty-dot')`)

  await fs.rename(testWorkspace, movedWorkspace)
  renamed = true
  await evaluate(`document.querySelector('.breadcrumbs button[title="Save"]').click(); return true`)
  await waitForRenderer(`document.querySelector('.toast.error')`, 10_000)
  const failureMessage = await evaluate(`return document.querySelector('.toast.error')?.textContent?.trim() ?? ''`)
  const savedBytes = await fs.readFile(movedFixturePath, 'utf8')
  const stillDirty = await evaluate(`return Boolean(document.querySelector('.editor-tabs button[title$="/${fixtureName}"] .dirty-dot'))`)
  if (!stillDirty || savedBytes !== baseline) throw new Error(`Moved-workspace save lost state: ${JSON.stringify({ stillDirty, savedBytes })}`)

  await fs.rename(movedWorkspace, testWorkspace)
  renamed = false
  originalConfirm = await evaluate(`
    window.__omnicodeWorkspaceSwitchConfirm = window.confirm
    window.confirm = () => true
    return true
  `)
  await dispatchDirectoryDrop(originalWorkspace)
  await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(originalWorkspace)}`)
  await showTerminal()
  await waitFor(async () => (await activeSession())?.title.endsWith(` — ${originalWorkspace}`), 'restored workspace terminal')
  const restored = await activeSession()
  const restoredId = sessionIdFromTabId(restored.id)
  if (restoredId === switchedId) throw new Error('Restoring the workspace did not replace the temporary PTY.')
  await evaluate(`
    window.confirm = window.__omnicodeWorkspaceSwitchConfirm
    delete window.__omnicodeWorkspaceSwitchConfirm
    return true
  `)
  originalConfirm = null

  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  console.log(JSON.stringify({
    terminal: {
      previousSessionReplaced: true,
      switchedCwd: testWorkspace,
      staleSessionIgnored: true,
      restoredSessionReplaced: true,
      restoredCwd: originalWorkspace
    },
    movedWorkspace: {
      visibleError: failureMessage,
      dirtyBufferPreserved: stillDirty,
      diskBytesPreserved: savedBytes === baseline
    },
    cleanup: { workspaceRestored: true, fixtureRemoved: true },
    runtimeErrors: unexpectedErrors
  }, null, 2))
} finally {
  if (renamed) await fs.rename(movedWorkspace, testWorkspace).catch(() => undefined)
  if (originalConfirm !== null) {
    await evaluate(`
      window.confirm = window.__omnicodeWorkspaceSwitchConfirm
      delete window.__omnicodeWorkspaceSwitchConfirm
      return true
    `).catch(() => undefined)
  }
  const currentWorkspace = await evaluate(`return document.querySelector('.workspace-heading')?.getAttribute('title') ?? ''`).catch(() => '')
  if (currentWorkspace !== originalWorkspace) {
    await evaluate(`window.confirm = () => true; return true`).catch(() => undefined)
    await dispatchDirectoryDrop(originalWorkspace).catch(() => undefined)
    await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(originalWorkspace)}`, 10_000).catch(() => undefined)
  }
  await fs.rm(testWorkspace, { recursive: true, force: true })
  await fs.rm(movedWorkspace, { recursive: true, force: true })
  socket.close()
}
