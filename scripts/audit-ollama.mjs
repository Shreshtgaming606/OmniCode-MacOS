const port = Number(process.argv[2] ?? 9352)

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
    expression: `(async () => { ${body} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  }
  return response.result.value
}
async function waitFor(expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`return Boolean(${expression})`).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitFor(`window.omnicode && document.querySelector('.app-shell')`)
const api = await evaluate(`
  const status = await window.omnicode.ai.ollamaStatus()
  const models = await window.omnicode.ai.models()
  const catalog = await window.omnicode.ai.modelCatalog()
  let chatError = ''
  try {
    await window.omnicode.ai.chat({
      provider: 'ollama',
      model: 'qwen2.5-coder:1.5b',
      messages: [{ role: 'user', content: 'Respond with exactly: OmniCode Local AI Test Successful' }]
    })
  } catch (error) {
    chatError = String(error)
  }
  return {
    status,
    installedModels: models.length,
    catalogModels: catalog.length,
    chatError
  }
`)
await evaluate(`document.querySelector('button[aria-label="AI Models"]').click(); return true`)
await waitFor(`document.querySelector('.models-view') && !document.querySelector('button[title="Refresh model list"]').disabled`)
const ui = await evaluate(`
  const state = document.querySelector('.ollama-state')
  const downloadButtons = [...document.querySelectorAll('button[title^="Start Ollama before downloading"]')]
  return {
    state: state?.querySelector('strong')?.textContent || '',
    detail: state?.querySelector('small')?.textContent || '',
    downloadButtons: downloadButtons.length,
    allDownloadsDisabled: downloadButtons.every((button) => button.disabled),
    error: document.querySelector('.models-error')?.textContent || ''
  }
`)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
if (api.status.installed || api.status.available) throw new Error(`Ollama API contradicted the absent host installation: ${JSON.stringify(api.status)}`)
if (api.installedModels !== 0 || api.catalogModels === 0) throw new Error(`Ollama model state was inaccurate: ${JSON.stringify(api)}`)
if (!api.chatError) throw new Error('Ollama chat falsely succeeded without a local service.')
if (ui.state !== 'Ollama not installed' || !ui.allDownloadsDisabled || ui.error) throw new Error(`Ollama UI state was inaccurate: ${JSON.stringify(ui)}`)
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({ api, ui, runtimeErrors: unexpectedErrors }, null, 2))
