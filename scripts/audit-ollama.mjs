const port = Number(process.argv[2] ?? 9352)

async function rendererTarget() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const target = await fetch(`http://127.0.0.1:${port}/json`)
      .then((response) => response.json())
      .then((targets) => targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && !item.url?.includes('omni-overlay.html')))
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
await waitFor(`window.omnicode && (document.querySelector('.app-shell') || document.querySelector('.onboarding'))`)
if (await evaluate(`return Boolean(document.querySelector('.onboarding'))`)) {
  await evaluate(`localStorage.setItem('omnicode.onboardingComplete', 'true'); location.reload(); return true`)
  await waitFor(`window.omnicode && document.querySelector('.app-shell')`)
}

await evaluate(`return await window.omnicode.ai.updateOllamaSettings({ endpoint: 'http://127.0.0.1:11434' })`)
const switching = await evaluate(`
  const originalOmni = await window.omnicode.omni.settings.get()
  const installed = await window.omnicode.ai.models()
  const alternate = installed.find((model) => model.provider === 'ollama' && model.installed && model.id !== 'phi3:mini')
  if (!alternate) throw new Error('A second installed Ollama model is required for the switching audit.')
  const alternatePreferences = await window.omnicode.ai.selectModel(alternate.id)
  const cloud = await window.omnicode.omni.settings.update({ model: { provider: 'google', modelId: 'gemini-2.5-flash' } })
  const local = await window.omnicode.omni.settings.update({ model: { provider: 'ollama', modelId: 'phi3:mini' } })
  const restoredPreferences = await window.omnicode.ai.selectModel('phi3:mini')
  await window.omnicode.omni.settings.update({ model: originalOmni.model })
  return {
    alternate: alternate.id,
    alternateSelected: alternatePreferences.selectedModel,
    cloudProvider: cloud.model.provider,
    cloudModel: cloud.model.modelId,
    localProvider: local.model.provider,
    localModel: local.model.modelId,
    restoredSelected: restoredPreferences.selectedModel
  }
`)
const api = await evaluate(`
  const [status, settings, models, preferences, localPolicy, connectors, workTools] = await Promise.all([
    window.omnicode.ai.ollamaStatus(),
    window.omnicode.ai.ollamaSettings(),
    window.omnicode.ai.models(),
    window.omnicode.ai.modelPreferences(),
    window.omnicode.work.providerPolicy('ollama', 'phi3:mini'),
    window.omnicode.work.connectors.list(true),
    window.omnicode.work.tools.list()
  ])
  return { status, settings, models, preferences, localPolicy, connectors, workTools }
`)

await evaluate(`document.querySelector('button[aria-label="Settings"]').click(); return true`)
await waitFor(`document.querySelector('.ollama-provider-setting') && document.querySelector('.ollama-provider-setting').getAttribute('aria-busy') === 'false'`)
await evaluate(`
  [...document.querySelectorAll('.ollama-provider-actions button')].find((button) => button.textContent.includes('Test Connection'))?.click()
  return true
`)
await waitFor(`document.querySelector('.ollama-provider-setting').getAttribute('aria-busy') === 'false'`)

const ui = await evaluate(`
  const card = document.querySelector('.ollama-provider-setting')
  const modelRows = [...card.querySelectorAll('.ollama-installed-models article')]
  const phi = modelRows.find((row) => row.textContent.includes('phi3:mini'))
  const endpoint = card.querySelector('input[aria-label="Ollama server endpoint"]')
  return {
    providerHeading: card.querySelector('.ollama-provider-heading strong')?.textContent ?? '',
    connectionState: card.querySelector('.ollama-provider-heading small')?.textContent ?? '',
    statusMessage: card.querySelector('.ollama-provider-status')?.textContent ?? '',
    version: card.querySelector('.ollama-provider-heading code')?.textContent ?? '',
    endpoint: endpoint?.value ?? '',
    endpointEnabled: !endpoint?.disabled,
    testConnection: [...card.querySelectorAll('button')].some((button) => button.textContent.includes('Test Connection')),
    refreshModels: [...card.querySelectorAll('button')].some((button) => button.textContent.includes('Refresh Models')),
    pullModel: Boolean(card.querySelector('input[aria-label="Ollama model to pull"]')),
    apiKeyInputs: card.querySelectorAll('input[type="password"]').length,
    modelCount: modelRows.length,
    phiPresent: Boolean(phi),
    phiSelected: phi?.classList.contains('selected') ?? false,
    phiDetails: phi?.querySelector('small')?.textContent ?? '',
    phiAction: phi?.querySelector('button:not(.icon-button)')?.textContent ?? '',
    error: card.querySelector('[role="alert"]')?.textContent ?? ''
  }
`)

const phi = api.models.find((model) => model.id === 'phi3:mini')
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
if (api.status.state !== 'connected' || !api.status.available || !api.status.installed) {
  throw new Error(`Ollama did not report a connected local service: ${JSON.stringify(api.status)}`)
}
if (api.settings.endpoint !== 'http://127.0.0.1:11434') throw new Error(`Ollama endpoint did not persist: ${JSON.stringify(api.settings)}`)
if (!phi?.installed || phi.modelCapabilities?.toolMode !== 'structured' || !phi.modelCapabilities?.supportsTools) {
  throw new Error(`phi3:mini capabilities were not discovered correctly: ${JSON.stringify(phi)}`)
}
if (api.preferences.selectedModel !== 'phi3:mini') throw new Error(`phi3:mini was not selected: ${JSON.stringify(api.preferences)}`)
if (switching.alternateSelected !== switching.alternate || switching.cloudProvider !== 'google' ||
  switching.localProvider !== 'ollama' || switching.localModel !== 'phi3:mini' || switching.restoredSelected !== 'phi3:mini') {
  throw new Error(`Provider/model switching failed: ${JSON.stringify(switching)}`)
}
if (ui.providerHeading !== 'Ollama · local' || ui.connectionState !== 'Connected' || ui.endpoint !== api.settings.endpoint ||
  !ui.endpointEnabled || !ui.testConnection || !ui.refreshModels || !ui.pullModel || ui.apiKeyInputs !== 0 ||
  !ui.phiPresent || !ui.phiSelected || !ui.phiDetails.includes('Structured tool adapter') || ui.phiAction !== 'In use' || ui.error) {
  throw new Error(`Ollama Settings UI was incomplete: ${JSON.stringify(ui)}`)
}
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  api: {
    status: api.status,
    settings: api.settings,
    selectedModel: api.preferences.selectedModel,
    localProviderPolicy: api.localPolicy,
    connectors: api.connectors.map((connector) => ({ id: connector.id, state: connector.status.state, grantedScopes: connector.status.grantedScopes })),
    workToolCount: api.workTools.length,
    phi: {
      family: phi.family,
      parameterSize: phi.parameterSize,
      quantization: phi.quantization,
      contextWindow: phi.contextWindow,
      capabilities: phi.modelCapabilities
    }
  },
  ui,
  switching,
  runtimeErrors: unexpectedErrors
}, null, 2))
