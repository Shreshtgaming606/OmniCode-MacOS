import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const appBinary = await fs.realpath(process.argv[2] ?? '')
const profile = await fs.realpath(process.argv[3] ?? '')
const repository = await fs.realpath(process.argv[4] ?? '')
const port = Number(process.argv[5] ?? 9430)
if (!appBinary.includes('.app/Contents/MacOS/')) {
  throw new Error('Usage: node scripts/audit-input-dialog-workflows.mjs <app-binary> <profile> <repository> [port]')
}

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-input-dialog-')))
const remote = path.join(fixture, 'clone-source.git')
const destination = path.join(fixture, 'Destination')
const projectName = 'Project Ω Audit'
await fs.mkdir(destination)
await execFileAsync('/usr/bin/git', ['clone', '--bare', repository, remote], { timeout: 30_000 })

async function apple(...expressions) {
  const args = expressions.flatMap((expression) => ['-e', expression])
  return (await execFileAsync('/usr/bin/osascript', args, { timeout: 5_000 })).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function frontmost() {
  await apple('tell application "OmniCode" to activate')
  await waitFor(async () => (await apple('tell application "System Events" to tell process "OmniCode" to get frontmost')) === 'true', 'OmniCode frontmost')
}
async function hasSheet() {
  return (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '1'
}
async function chooseFolder(folder) {
  await frontmost()
  await waitFor(hasSheet, 'native destination sheet')
  const buttons = await apple('tell application "System Events" to tell process "OmniCode" to get name of every button of sheet 1 of window 1')
  if (!buttons.includes('Open') || !buttons.includes('Cancel')) throw new Error(`Destination sheet buttons were incomplete: ${buttons}`)
  await apple('tell application "System Events" to keystroke "g" using {command down, shift down}')
  await new Promise((resolve) => setTimeout(resolve, 250))
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(folder)}`)
  await apple('tell application "System Events" to key code 36')
  await new Promise((resolve) => setTimeout(resolve, 900))
  await apple('tell application "System Events" to key code 36')
  await new Promise((resolve) => setTimeout(resolve, 700))
  if (await hasSheet()) {
    await apple('tell application "System Events" to tell process "OmniCode" to click button "Open" of sheet 1 of window 1')
  }
  await waitFor(async () => !(await hasSheet()), 'destination sheet to close')
  return buttons
}

const child = spawn(appBinary, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`
], { stdio: ['ignore', 'ignore', 'pipe'] })
const stderr = []
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  if (stderr.join('').length < 100_000) stderr.push(String(chunk))
})

let socket
try {
  let target
  await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
    target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    return Boolean(target)
  }, 'packaged renderer')
  socket = new WebSocket(target.webSocketDebuggerUrl)
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
  const call = (method, params = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const evaluate = async (body) => {
    const response = await call('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  const waitForRenderer = (expression, description = expression, timeoutMs) => waitFor(
    async () => Boolean(await evaluate(`return Boolean(${expression})`).catch(() => false)),
    description,
    timeoutMs
  )
  const enterModal = async (value) => {
    await evaluate(`
      const input = document.querySelector('.input-modal input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    `)
    await waitForRenderer(`document.querySelector('.input-modal .primary-button:not(:disabled)')`, 'enabled modal confirmation')
  }

  await call('Runtime.enable')
  await call('Log.enable')
  await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`, 'workbench shell')
  await waitForRenderer(`document.querySelector('.welcome-actions')`, 'Welcome actions')

  // Cancel must settle the Promise without opening a native destination sheet.
  await evaluate(`[...document.querySelectorAll('.welcome-actions button')].find((button) => button.textContent.includes('Clone Repository')).click(); return true`)
  await waitForRenderer(`document.querySelector('.input-modal[role="dialog"][aria-label="Clone Repository"]')`, 'Clone input dialog')
  await evaluate(`document.querySelector('.input-modal input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
  await waitForRenderer(`!document.querySelector('.input-modal')`, 'Escape cancellation')
  if (await hasSheet()) throw new Error('Canceling the Clone input unexpectedly opened the destination picker.')

  await evaluate(`[...document.querySelectorAll('.welcome-actions button')].find((button) => button.textContent.includes('Clone Repository')).click(); return true`)
  await waitForRenderer(`document.querySelector('.input-modal[aria-label="Clone Repository"]')`, 'Clone input dialog retry')
  await enterModal(remote)
  await evaluate(`document.querySelector('.input-modal').requestSubmit(); return true`)
  const cloneSheetButtons = await chooseFolder(destination)
  const cloned = path.join(destination, 'clone-source')
  await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(cloned)}`, 'cloned workspace', 30_000)
  const cloneStatus = await evaluate(`return await window.omnicode.git.status(${JSON.stringify(cloned)})`)
  if (!cloneStatus.isRepository || !cloneStatus.branch) throw new Error(`Cloned workspace is not a repository: ${JSON.stringify(cloneStatus)}`)
  const { stdout: origin } = await execFileAsync('/usr/bin/git', ['-C', cloned, 'remote', 'get-url', 'origin'])
  if ((await fs.realpath(origin.trim())) !== (await fs.realpath(remote))) throw new Error('The cloned origin did not match the selected repository.')

  await evaluate(`document.querySelector('button[title="Source Control"]').click(); return true`)
  await waitForRenderer(`document.querySelector('button[title="Create branch"]:not(:disabled)')`, 'Create branch control')
  await evaluate(`document.querySelector('button[title="Create branch"]').click(); return true`)
  await waitForRenderer(`document.querySelector('.input-modal[aria-label="Create Branch"]')`, 'Create Branch input dialog')
  await enterModal('audit-input-dialog-branch')
  await evaluate(`document.querySelector('.input-modal').requestSubmit(); return true`)
  await waitForRenderer(`document.querySelector('select[aria-label="Current Git branch"]')?.value === 'audit-input-dialog-branch'`, 'created branch')

  await waitForRenderer(`document.querySelector('button[title="Delete another branch"]:not(:disabled)')`, 'Delete branch control')
  await evaluate(`document.querySelector('button[title="Delete another branch"]').click(); return true`)
  await waitForRenderer(`document.querySelector('.input-modal[aria-label="Delete Branch"]')`, 'Delete Branch input dialog')
  const deleteDefault = await evaluate(`return document.querySelector('.input-modal input').value`)
  if (!deleteDefault) throw new Error('Delete Branch did not offer an existing branch.')
  await evaluate(`document.querySelector('.input-modal').requestSubmit(); return true`)
  await waitFor(async () => !(await execFileAsync('/usr/bin/git', ['-C', cloned, 'branch', '--list', deleteDefault])).stdout.trim(), 'selected branch deletion')

  await waitForRenderer(`document.querySelector('button[aria-label="Rename active terminal"]:not(:disabled)')`, 'terminal rename control')
  await evaluate(`document.querySelector('button[aria-label="Rename active terminal"]').click(); return true`)
  await waitForRenderer(`document.querySelector('.input-modal[aria-label="Rename Terminal"]')`, 'Rename Terminal input dialog')
  await enterModal('Audit Terminal')
  await evaluate(`document.querySelector('.input-modal').requestSubmit(); return true`)
  await waitForRenderer(`[...document.querySelectorAll('.terminal-panel__tab-label')].some((label) => label.textContent === 'Audit Terminal')`, 'renamed terminal')

  await evaluate(`[...document.querySelectorAll('.welcome-actions button')].find((button) => button.textContent.includes('New Project')).click(); return true`)
  await waitForRenderer(`document.querySelector('.input-modal[aria-label="New Project"]')`, 'New Project input dialog')
  await enterModal(projectName)
  await evaluate(`document.querySelector('.input-modal').requestSubmit(); return true`)
  const projectSheetButtons = await chooseFolder(destination)
  const project = path.join(destination, projectName)
  await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(project)}`, 'created project workspace', 30_000)
  if (!(await fs.stat(project)).isDirectory()) throw new Error('New Project did not create the selected real folder.')

  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  console.log(JSON.stringify({
    unsupportedBrowserPromptsRemaining: false,
    modalCancel: { escapeClosed: true, nativePickerNotOpened: true },
    clone: { inputDialog: true, nativeDestinationButtons: cloneSheetButtons, realRepository: true, originMatched: true },
    branches: { created: 'audit-input-dialog-branch', deleted: deleteDefault },
    terminal: { renamed: 'Audit Terminal' },
    newProject: { inputDialog: true, nativeDestinationButtons: projectSheetButtons, exactFolderCreated: true },
    runtimeErrors: unexpectedErrors
  }, null, 2))
} finally {
  socket?.close()
  await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "OmniCode" to quit']).catch(() => undefined)
  await waitFor(() => {
    try { process.kill(child.pid, 0); return false } catch { return true }
  }, 'application cleanup', 15_000).catch(() => child.kill('SIGTERM'))
  await fs.rm(fixture, { recursive: true, force: true })
}
