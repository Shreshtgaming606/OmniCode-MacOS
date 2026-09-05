import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9333)
let workspace = process.argv[3]
const screenshotPath = process.argv[4]

if (!workspace) {
  throw new Error('Usage: node scripts/smoke-packaged.mjs <debug-port> <workspace> [screenshot.png]')
}
workspace = await fs.realpath(workspace)

async function targetsWhenReady() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) return await response.json()
    } catch {
      // The packaged app may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for packaged app debugging port ${port}.`)
}

const targets = await targetsWhenReady()
const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
if (!target) throw new Error('No packaged renderer DevTools target was found.')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const runtimeErrors = []
let nextId = 1

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id) {
    const operation = pending.get(message.id)
    if (!operation) return
    pending.delete(message.id)
    if (message.error) operation.reject(new Error(message.error.message))
    else operation.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    runtimeErrors.push(message.params?.exceptionDetails?.text ?? 'Runtime exception')
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

async function evaluate(expression) {
  const response = await call('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  }
  return response.result.value
}

async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(`return Boolean(${expression})`)) return
    } catch {
      // Reloads briefly invalidate the execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

await call('Runtime.enable')
await call('Log.enable')
await call('Page.enable')

const initial = await evaluate(`return {
  title: document.title,
  url: location.href,
  onboarding: Boolean(document.querySelector('.onboarding'))
}`)
if (initial.title !== 'OmniCode' || !initial.url.startsWith('file:')) {
  throw new Error(`Unexpected packaged renderer: ${JSON.stringify(initial)}`)
}

await evaluate(`
  localStorage.setItem('omnicode.onboardingComplete', 'true')
  return true
`)
await call('Page.reload', { ignoreCache: true })
await waitFor(`document.querySelector('.app-shell') && window.omnicode`)

const workspaceLiteral = JSON.stringify(workspace)
await waitFor(`document.querySelector('.workbench')`)
await waitFor(`await window.omnicode.workspace.readTree(${workspaceLiteral}).then(() => true).catch(() => false)`)
const appResult = await evaluate(`
  const workspace = ${workspaceLiteral}
  const version = await window.omnicode.app.version()
  const recent = await window.omnicode.workspace.recentWorkspaces()
  const tree = await window.omnicode.workspace.readTree(workspace)
  const settings = await window.omnicode.settings.read(workspace)
  return { version, recentHasWorkspace: recent.includes(workspace), treeEntries: tree.length, settings }
`)
if (!appResult.recentHasWorkspace || appResult.treeEntries < 1) {
  throw new Error(`Workspace IPC smoke test failed: ${JSON.stringify(appResult)}`)
}

const terminalResult = await evaluate(`
  const workspace = ${workspaceLiteral}
  return await new Promise(async (resolve, reject) => {
    let sessionId = ''
    let session
    let output = ''
    const timeout = setTimeout(() => {
      unsubscribeData()
      reject(new Error('PTY smoke test timed out.'))
    }, 10_000)
    const unsubscribeData = window.omnicode.terminal.onData((event) => {
      if (event.id !== sessionId) return
      output += event.data
      if (!output.includes('__OMNICODE_PTY_OK__')) return
      clearTimeout(timeout)
      unsubscribeData()
      void window.omnicode.terminal.kill(sessionId).finally(() => resolve({
        shell: session.shell,
        output: output.slice(-500)
      }))
    })
    try {
      session = await window.omnicode.terminal.create({ cwd: workspace, name: 'Release smoke test' })
      sessionId = session.id
      window.omnicode.terminal.write(sessionId, "printf '\\\\137\\\\137OMNICODE_PTY_OK\\\\137\\\\137\\\\n'\\n")
    } catch (error) {
      clearTimeout(timeout)
      unsubscribeData()
      reject(error)
    }
  })
`)
if (!terminalResult.output.includes('__OMNICODE_PTY_OK__')) {
  throw new Error(`PTY output was not captured: ${JSON.stringify(terminalResult)}`)
}

const serverResult = await evaluate(`
  const state = await window.omnicode.server.start(${workspaceLiteral})
  try {
    const publicStatus = (await fetch(state.url + '/README.md')).status
    const gitStatus = (await fetch(state.url + '/.git/config')).status
    const environmentStatus = (await fetch(state.url + '/.env')).status
    return { publicStatus, gitStatus, environmentStatus, url: state.url }
  } finally {
    await window.omnicode.server.stop()
  }
`)
if (serverResult.publicStatus !== 200 || serverResult.gitStatus !== 403 || serverResult.environmentStatus !== 403) {
  throw new Error(`Static-server boundary smoke test failed: ${JSON.stringify(serverResult)}`)
}

if (screenshotPath) {
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
}

await evaluate(`location.href = 'https://example.com/'; return true`)
await new Promise((resolve) => setTimeout(resolve, 750))
const navigation = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
const pageUrl = navigation.find((item) => item.type === 'page')?.url ?? ''
if (!pageUrl.startsWith('file:')) throw new Error(`External navigation was not blocked: ${pageUrl}`)

const unexpectedErrors = runtimeErrors.filter((message) =>
  !/ResizeObserver loop|Failed to load resource.*(?:403|404)/i.test(message)
)
if (unexpectedErrors.length) {
  throw new Error(`Packaged renderer logged errors: ${unexpectedErrors.join(' | ')}`)
}

socket.close()
console.log(JSON.stringify({
  renderer: initial,
  workspace: appResult,
  terminal: terminalResult,
  staticServer: serverResult,
  navigationBlocked: true,
  screenshotPath,
  runtimeErrors: unexpectedErrors
}, null, 2))
