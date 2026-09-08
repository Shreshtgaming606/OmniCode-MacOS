import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9390)

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function notificationVisible(token) {
  const script = `
    tell application "System Events"
      if not (exists application process "NotificationCenter") then return false
      tell application process "NotificationCenter"
        repeat with currentElement in entire contents
          try
            if (name of currentElement as text) contains ${JSON.stringify(token)} then return true
          end try
          try
            if (value of currentElement as text) contains ${JSON.stringify(token)} then return true
          end try
          try
            if (description of currentElement as text) contains ${JSON.stringify(token)} then return true
          end try
        end repeat
      end tell
    end tell
    return false
  `
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 5_000 })
  return stdout.trim() === 'true'
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

await call('Runtime.enable')
await call('Log.enable')
await waitFor(async () => evaluate(`return Boolean(window.omnicode && document.querySelector('.app-shell'))`), 'workbench')
const token = `OmniCode Notification Audit ${process.pid}`
const validation = await evaluate(`
  const errors = []
  for (const [title, body] of [['', 'body'], ['x'.repeat(121), 'body'], ['title', 'x'.repeat(501)]]) {
    try { await window.omnicode.app.notify(title, body) }
    catch (error) { errors.push(String(error)) }
  }
  return errors
`)
if (validation.length !== 3 || validation.some((message) => !/invalid or too long/iu.test(message))) {
  throw new Error(`Notification validation was inaccurate: ${JSON.stringify(validation)}`)
}

await evaluate(`await window.omnicode.app.notify(${JSON.stringify(token)}, 'Native macOS notification delivery verification.'); return true`)
let visible = false
await waitFor(async () => {
  visible = await notificationVisible(token)
  return visible
}, 'native notification banner', 10_000).catch(() => undefined)

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  validNotificationAccepted: true,
  nativeBannerObserved: visible,
  invalidContentRejected: validation.length,
  runtimeErrors: unexpectedErrors
}, null, 2))
