import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const appBinary = await fs.realpath(process.argv[2] ?? '')
const profile = await fs.realpath(process.argv[3] ?? '')
const workspace = await fs.realpath(process.argv[4] ?? '')
const port = Number(process.argv[5] ?? 9420)

if (!appBinary.includes('.app/Contents/MacOS/')) {
  throw new Error('Usage: node scripts/audit-recent-workspace-restart.mjs <app-binary> <profile> <workspace> [port]')
}

async function waitFor(check, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}.`)
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
  }, 'restarted packaged renderer')
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
  await call('Runtime.enable')
  await call('Log.enable')
  await waitFor(async () => evaluate(`return Boolean(window.omnicode && document.querySelector('.app-shell'))`), 'workbench shell')
  await waitFor(async () => evaluate(`return [...document.querySelectorAll('.recent-list button')].some((button) => button.textContent.includes(${JSON.stringify(workspace)}))`), 'persisted recent workspace')
  const recent = await evaluate(`return await window.omnicode.workspace.recentWorkspaces()`)
  if (!recent.includes(workspace)) throw new Error(`Backend recents omitted the workspace: ${JSON.stringify(recent)}`)
  await evaluate(`
    const button = [...document.querySelectorAll('.recent-list button')].find((item) => item.textContent.includes(${JSON.stringify(workspace)}))
    button.click()
    return true
  `)
  await waitFor(async () => evaluate(`return document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(workspace))}`), 'recent workspace to reopen')
  const tree = await evaluate(`return await window.omnicode.workspace.readTree(${JSON.stringify(workspace)})`)
  if (!Array.isArray(tree) || !tree.length || tree.some((entry) => !entry.path.startsWith(`${workspace}${path.sep}`))) {
    throw new Error('The reopened workspace tree was not backed by the expected folder.')
  }
  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)

  console.log(JSON.stringify({
    restartedWithoutLaunchPath: true,
    recentRendered: true,
    backendPersisted: true,
    reopenedExactWorkspace: workspace,
    realTreeEntries: tree.length,
    runtimeErrors: unexpectedErrors
  }, null, 2))
} finally {
  socket?.close()
  await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "OmniCode" to quit']).catch(() => undefined)
  await waitFor(() => {
    try { process.kill(child.pid, 0); return false } catch { return true }
  }, 'restarted application cleanup', 15_000).catch(() => child.kill('SIGTERM'))
}
