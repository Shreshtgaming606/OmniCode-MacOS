import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9333)
const screenshotPath = process.argv[3]
const runLiveGoogle = process.env.OMNICODE_LIVE_GOOGLE === '1'

async function targetsWhenReady() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) return await response.json()
    } catch { /* packaged app may still be starting */ }
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
    if (await evaluate(`return Boolean(${expression})`).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

await call('Runtime.enable')
await call('Log.enable')
await call('Page.enable')
await waitFor(`document.querySelector('.app-shell') && window.omnicode`)

await evaluate(`
  const workButton = [...document.querySelectorAll('.mode-switcher [role="radio"]')]
    .find((button) => button.textContent?.includes('Work'))
  if (!workButton) throw new Error('Work Mode switch was not rendered.')
  workButton.click()
  return true
`)
await waitFor(`document.querySelector('.work-mode-shell') && document.querySelector('.work-mode-host')?.getAttribute('aria-hidden') === 'false'`)

const surface = await evaluate(`return {
  workVisible: document.querySelector('.work-mode-host')?.getAttribute('aria-hidden') === 'false',
  codePreserved: Boolean(document.querySelector('.code-mode-host .workbench')),
  providerSelector: Boolean(document.querySelector('[aria-label="Work AI provider"]')),
  modelSelector: Boolean(document.querySelector('[aria-label="Work AI model"]')),
  history: Boolean(document.querySelector('.work-history')),
  connectedApps: Boolean(document.querySelector('.work-connected-apps')),
  composer: Boolean(document.querySelector('[aria-label="Message OmniCode Work"]'))
}`)
if (!Object.values(surface).every(Boolean)) throw new Error(`Work Mode surface smoke failed: ${JSON.stringify(surface)}`)

const workResult = await evaluate(`
  const unique = 'Packaged Work Smoke ' + Date.now()
  const created = await window.omnicode.work.conversations.create({ provider: 'google', modelId: 'gemini-test' })
  try {
    const updated = await window.omnicode.work.conversations.update(created.id, { title: unique, pinned: true })
    const message = await window.omnicode.work.conversations.addMessage(created.id, { role: 'user', content: 'Persistence marker' })
    const reopened = await window.omnicode.work.conversations.get(created.id)
    const searched = await window.omnicode.work.conversations.search({ query: unique, limit: 5 })
    const connected = await window.omnicode.work.connectors.connect('browser')
    const tools = await window.omnicode.work.tools.list()
    const page = await window.omnicode.work.tools.execute({ toolId: 'browser.open', mode: 'work', input: { url: 'https://example.com/' } })
    const found = await window.omnicode.work.tools.execute({ toolId: 'browser.find', mode: 'work', input: { query: 'Example Domain' } })
    const disconnected = await window.omnicode.work.connectors.disconnect('browser')
    return {
      titlePersisted: updated.title === unique && reopened.title === unique,
      messagePersisted: reopened.messages.some((candidate) => candidate.id === message.id && candidate.content === 'Persistence marker'),
      searchFound: searched.some((candidate) => candidate.id === created.id),
      connected: connected.state === 'connected',
      browserTools: tools.filter((tool) => tool.connectorId === 'browser').map((tool) => tool.id).sort(),
      pageTitle: page.result?.title,
      findCount: found.result?.count,
      disconnected: disconnected.state === 'not-connected'
    }
  } finally {
    await window.omnicode.work.connectors.disconnect('browser').catch(() => undefined)
    await window.omnicode.work.conversations.delete(created.id).catch(() => undefined)
  }
`)
if (
  !workResult.titlePersisted || !workResult.messagePersisted || !workResult.searchFound ||
  !workResult.connected || workResult.pageTitle !== 'Example Domain' ||
  !(workResult.findCount >= 1) || !workResult.disconnected ||
  workResult.browserTools.join(',') !== 'browser.find,browser.open,browser.read'
) {
  throw new Error(`Work Mode backend smoke failed: ${JSON.stringify(workResult)}`)
}

let liveGoogle
if (runLiveGoogle) {
  liveGoogle = await evaluate(`
    const catalog = await window.omnicode.ai.cloudModelCatalog('google', { forceRefresh: true })
    const model = catalog.models.find((candidate) => candidate.id === 'gemini-3.7-flash') ?? catalog.models[0]
    if (!model) throw new Error('No Gemini model is available for the live Work smoke.')
    const requestId = 'worksmoke_' + Date.now()
    let streamed = ''
    const unsubscribe = window.omnicode.work.agent.onEvent((event) => {
      if (event.requestId === requestId) streamed += event.delta
    })
    try {
      const response = await window.omnicode.work.agent.chat(requestId, {
        provider: 'google', model: model.id,
        messages: [{ role: 'user', content: 'Respond with exactly: OmniCode Packaged Work Test Successful' }]
      })
      return {
        model: model.id,
        content: response.content.trim(),
        streamed: streamed.trim(),
        toolCallCount: response.toolCallCount
      }
    } finally { unsubscribe() }
  `)
  if (
    liveGoogle.content !== 'OmniCode Packaged Work Test Successful' ||
    liveGoogle.streamed !== liveGoogle.content
  ) throw new Error(`Live Gemini Work smoke failed: ${JSON.stringify(liveGoogle)}`)
}

if (screenshotPath) {
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
}

await evaluate(`
  const codeButton = [...document.querySelectorAll('.mode-switcher [role="radio"]')]
    .find((button) => button.textContent?.includes('Code'))
  codeButton?.click()
  return true
`)
await waitFor(`document.querySelector('.code-mode-host')?.getAttribute('aria-hidden') === 'false'`)

const unexpectedErrors = runtimeErrors.filter((message) =>
  !/ResizeObserver loop|Failed to load resource.*(?:403|404)/i.test(message)
)
if (unexpectedErrors.length) throw new Error(`Packaged renderer logged errors: ${unexpectedErrors.join(' | ')}`)

socket.close()
console.log(JSON.stringify({ surface, workResult, liveGoogle, screenshotPath, runtimeErrors: unexpectedErrors }, null, 2))
