import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9334)
let expectedPath = process.argv[3]
const screenshotPath = process.argv[4]

if (!expectedPath) throw new Error('Usage: node scripts/smoke-open-file.mjs <debug-port> <expected-file> [screenshot.png]')
expectedPath = await fs.realpath(expectedPath)

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

const target = (await targetsWhenReady()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
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
  if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params?.exceptionDetails?.text ?? 'Runtime exception')
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') runtimeErrors.push(message.params.entry.text)
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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

await call('Runtime.enable')
await call('Log.enable')
await call('Page.enable')
const expectedLiteral = JSON.stringify(expectedPath)
const deadline = Date.now() + 20_000
let result
while (Date.now() < deadline) {
  result = await evaluate(`
    const expected = ${expectedLiteral}
    const tab = document.querySelector('.editor-tabs button[title="' + CSS.escape(expected) + '"]')
    return tab ? { title: document.title, path: tab.title, label: tab.textContent, active: tab.classList.contains('active') } : null
  `).catch(() => null)
  if (result) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!result) {
  const diagnostic = await evaluate(`return {
    onboarding: Boolean(document.querySelector('.onboarding')),
    appShell: Boolean(document.querySelector('.app-shell')),
    tabs: [...document.querySelectorAll('.editor-tabs button')].map((tab) => ({ title: tab.title, text: tab.textContent })),
    body: document.body.innerText.slice(0, 1_000),
    onboardingComplete: localStorage.getItem('omnicode.onboardingComplete')
  }`).catch(() => null)
  const readyRetry = await evaluate(`
    try {
      await window.omnicode.app.ready()
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      return {
        tabs: [...document.querySelectorAll('.editor-tabs button')].map((tab) => ({ title: tab.title, text: tab.textContent })),
        toast: document.querySelector('.toast')?.textContent ?? null
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  `).catch(() => null)
  throw new Error(`Cold-start open did not create an editor tab for ${expectedPath}. State: ${JSON.stringify(diagnostic)} Ready retry: ${JSON.stringify(readyRetry)}`)
}

const editorDeadline = Date.now() + 15_000
while (Date.now() < editorDeadline) {
  if (await evaluate(`return Boolean(document.querySelector('.monaco-editor'))`).catch(() => false)) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!await evaluate(`return Boolean(document.querySelector('.monaco-editor'))`).catch(() => false)) {
  const diagnostic = await evaluate(`return {
    editorHost: document.querySelector('.editor-host')?.innerHTML.slice(0, 2_000),
    hasMonacoGlobal: Boolean(window.monaco),
    resources: performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => ['monaco', 'loader', 'worker', '/vs/'].some((part) => name.toLowerCase().includes(part))).slice(-20),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content
  }`).catch(() => null)
  throw new Error(`The editor tab opened for ${expectedPath}, but Monaco did not finish loading. State: ${JSON.stringify(diagnostic)}`)
}

const remoteEditorResources = await evaluate(`return performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /^https?:/i.test(name) && /monaco|jsdelivr|unpkg/i.test(name))`)
if (remoteEditorResources.length) throw new Error(`Monaco attempted to load remote runtime resources: ${remoteEditorResources.join(', ')}`)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/i.test(message))
if (unexpectedErrors.length) throw new Error(`Packaged editor logged errors: ${unexpectedErrors.join(' | ')}`)

if (screenshotPath) {
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
}

socket.close()
console.log(JSON.stringify({ ...result, offlineMonaco: true, runtimeErrors: unexpectedErrors, screenshotPath: screenshotPath ?? null }, null, 2))
