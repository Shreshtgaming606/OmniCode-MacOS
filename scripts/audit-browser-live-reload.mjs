import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const workspace = await fs.realpath(process.argv[3] ?? '')
const indexPath = path.join(workspace, 'index.html')
const beforeTitle = `OMNICODE_LIVE_BEFORE_${process.pid}`
const afterTitle = `OMNICODE_LIVE_AFTER_${process.pid}`

async function apple(expression) {
  return (await execFileAsync('/usr/bin/osascript', ['-e', expression], { timeout: 5_000 })).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function browserState(browser) {
  if (browser !== 'Safari' && browser !== 'Google Chrome') {
    throw new Error(`The default browser ${browser} is not supported by this audit.`)
  }
  // Read the accessibility window title through the already-authorized System
  // Events process. This does not require browser-specific Automation access.
  return {
    title: await apple(`tell application "System Events" to tell process ${JSON.stringify(browser)} to get name of front window`)
  }
}

let target
await waitFor(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
  target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  return Boolean(target)
}, 'packaged renderer')
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

const previousIndex = await fs.readFile(indexPath).then((content) => ({ exists: true, content })).catch(() => ({ exists: false, content: Buffer.alloc(0) }))
let browser = ''
try {
  await call('Runtime.enable')
  await call('Log.enable')
  await fs.writeFile(indexPath, `<!doctype html><title>${beforeTitle}</title><h1>Before reload</h1>`)
  const server = await evaluate(`return await window.omnicode.server.start(${JSON.stringify(workspace)})`)
  await evaluate(`await window.omnicode.server.open(); return true`)
  await waitFor(async () => {
    browser = await apple('tell application "System Events" to get name of first application process whose frontmost is true')
    return browser === 'Safari' || browser === 'Google Chrome'
  }, 'default browser to become frontmost')
  await waitFor(async () => {
    const state = await browserState(browser)
    return state.title.includes(beforeTitle)
  }, 'default browser to render the local page')

  await fs.writeFile(indexPath, `<!doctype html><title>${afterTitle}</title><h1>After live reload</h1>`)
  await waitFor(async () => (await browserState(browser)).title.includes(afterTitle), 'browser live reload', 20_000)
  const finalBrowser = await browserState(browser)
  await evaluate(`await window.omnicode.server.stop(); return true`)
  const stopped = await evaluate(`return await window.omnicode.server.state()`)
  if (stopped.running) throw new Error('Server remained running after the browser audit.')
  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  console.log(JSON.stringify({
    defaultBrowser: browser,
    launchedUrl: server.url,
    initialTitle: beforeTitle,
    reloadedTitle: finalBrowser.title,
    liveReload: true,
    serverStopped: true,
    runtimeErrors: unexpectedErrors
  }, null, 2))
} finally {
  await evaluate(`await window.omnicode.server.stop(); return true`).catch(() => undefined)
  if (previousIndex.exists) await fs.writeFile(indexPath, previousIndex.content)
  else await fs.rm(indexPath, { force: true })
  if (browser) await apple(`tell application "System Events" to tell process ${JSON.stringify(browser)} to set frontmost to true`).catch(() => undefined)
  if (browser) await apple('tell application "System Events" to keystroke "w" using command down').catch(() => undefined)
  await apple('tell application "OmniCode" to activate').catch(() => undefined)
  socket.close()
}
