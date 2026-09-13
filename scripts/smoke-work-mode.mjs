import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9333)
const screenshotPath = process.argv[3]
const runLiveGoogle = process.env.OMNICODE_LIVE_GOOGLE === '1'
const googleOAuthConfigured = Boolean(process.env.OMNICODE_GOOGLE_OAUTH_CLIENT_ID)
const smokeTheme = ['dark', 'light'].includes(process.env.OMNICODE_SMOKE_THEME) ? process.env.OMNICODE_SMOKE_THEME : undefined
const compactWindow = process.env.OMNICODE_SMOKE_COMPACT === '1'

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
await waitFor(`window.omnicode && (document.querySelector('.app-shell') || document.querySelector('.onboarding'))`)
const onboardingVisible = await evaluate(`return Boolean(document.querySelector('.onboarding'))`)
if (onboardingVisible || smokeTheme) {
  await evaluate(`
    localStorage.setItem('omnicode.onboardingComplete', 'true')
    ${smokeTheme ? `localStorage.setItem('omnicode.theme', ${JSON.stringify(smokeTheme)})` : ''}
    location.reload()
    return true
  `).catch(() => undefined)
  await waitFor(`document.querySelector('.app-shell') && window.omnicode && !document.querySelector('.onboarding')`)
}

await evaluate(`
  const workButton = [...document.querySelectorAll('.mode-switcher [role="radio"]')]
    .find((button) => button.textContent?.includes('Work'))
  if (!workButton) throw new Error('Work Mode switch was not rendered.')
  workButton.click()
  return true
`)
await waitFor(`document.querySelector('.work-mode-shell') && document.querySelector('.work-mode-host')?.getAttribute('aria-hidden') === 'false'`)
if (compactWindow) {
  await evaluate(`window.resizeTo(960, 600); return true`)
  await new Promise((resolve) => setTimeout(resolve, 400))
}

const surface = await evaluate(`return {
  workVisible: document.querySelector('.work-mode-host')?.getAttribute('aria-hidden') === 'false',
  codePreserved: Boolean(document.querySelector('.code-mode-host .workbench')),
  providerSelector: Boolean(document.querySelector('[aria-label="Work AI provider"]')),
  modelSelector: Boolean(document.querySelector('[aria-label="Work AI model"]')),
  history: Boolean(document.querySelector('.work-history')),
  connectedApps: Boolean(document.querySelector('.work-connected-apps')),
  composer: Boolean(document.querySelector('[aria-label="Message OmniCode Work"]')),
  theme: document.documentElement.dataset.theme,
  viewport: [window.innerWidth, window.innerHeight],
  noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth
}`)
if (!surface.workVisible || !surface.codePreserved || !surface.providerSelector || !surface.modelSelector || !surface.history || !surface.connectedApps || !surface.composer || !surface.noHorizontalOverflow) {
  throw new Error(`Work Mode surface smoke failed: ${JSON.stringify(surface)}`)
}
if (smokeTheme && surface.theme !== smokeTheme) throw new Error(`Expected ${smokeTheme} theme, received ${surface.theme}.`)

await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
const reducedMotion = await evaluate(`return getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim()`)
await call('Emulation.setEmulatedMedia', { features: [] })
if (reducedMotion !== '1ms') throw new Error(`Reduced-motion tokens were not applied: ${reducedMotion}`)

const stress = await evaluate(`
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const mode = (name) => [...document.querySelectorAll('.mode-switcher [role="radio"]')]
    .find((button) => button.textContent?.includes(name))
  for (let index = 0; index < 12; index++) {
    mode(index % 2 === 0 ? 'Code' : 'Work')?.click()
    await pause(24)
  }
  mode('Work')?.click()
  await pause(80)
  document.querySelector('.work-connected-apps > header button')?.click()
  await pause(80)
  const appsOpened = Boolean(document.querySelector('.work-apps-dialog'))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await pause(80)
  const appsClosed = !document.querySelector('.work-apps-dialog')
  document.querySelector('.work-settings-link')?.click()
  await pause(80)
  const settingsOpened = Boolean(document.querySelector('.settings-panel'))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await pause(80)
  return {
    appsOpened,
    appsClosed,
    settingsOpened,
    settingsClosed: !document.querySelector('.settings-panel'),
    oneCodeHost: document.querySelectorAll('.code-mode-host').length === 1,
    oneWorkHost: document.querySelectorAll('.work-mode-host').length === 1,
    workVisible: document.querySelector('.work-mode-host')?.getAttribute('aria-hidden') === 'false',
    stuckOverlays: document.querySelectorAll('.modal-backdrop').length
  }
`)
if (!stress.appsOpened || !stress.appsClosed || !stress.settingsOpened || !stress.settingsClosed || !stress.oneCodeHost || !stress.oneWorkHost || !stress.workVisible || stress.stuckOverlays !== 0) {
  throw new Error(`Work Mode animation/overlay stress failed: ${JSON.stringify(stress)}`)
}

const workResult = await evaluate(`
  const unique = 'Packaged Work Smoke ' + Date.now()
  const created = await window.omnicode.work.conversations.create({ provider: 'google', modelId: 'gemini-test' })
  try {
    const updated = await window.omnicode.work.conversations.update(created.id, { title: unique, pinned: true })
    const message = await window.omnicode.work.conversations.addMessage(created.id, { role: 'user', content: 'Persistence marker' })
    const reopened = await window.omnicode.work.conversations.get(created.id)
    const searched = await window.omnicode.work.conversations.search({ query: unique, limit: 5 })
    const connected = await window.omnicode.work.connectors.connect('browser')
    const connectors = await window.omnicode.work.connectors.list(true)
    const tools = await window.omnicode.work.tools.list()
    const page = await window.omnicode.work.tools.execute({ toolId: 'browser.open', mode: 'work', input: { url: 'https://example.com/' } })
    const found = await window.omnicode.work.tools.execute({ toolId: 'browser.find', mode: 'work', input: { query: 'Example Domain' } })
    const disconnected = await window.omnicode.work.connectors.disconnect('browser')
    return {
      titlePersisted: updated.title === unique && reopened.title === unique,
      messagePersisted: reopened.messages.some((candidate) => candidate.id === message.id && candidate.content === 'Persistence marker'),
      searchFound: searched.some((candidate) => candidate.id === created.id),
      connected: connected.state === 'connected',
      connectorStates: Object.fromEntries(connectors.map((connector) => [connector.id, connector.status.state])),
      browserTools: tools.filter((tool) => tool.connectorId === 'browser').map((tool) => tool.id).sort(),
      gmailTools: tools.filter((tool) => tool.connectorId === 'gmail').map((tool) => tool.id).sort(),
      driveTools: tools.filter((tool) => tool.connectorId === 'google-drive').map((tool) => tool.id).sort(),
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
  workResult.browserTools.join(',') !== 'browser.find,browser.open,browser.read' ||
  workResult.gmailTools.length !== 13 || workResult.driveTools.length !== 15 ||
  (!googleOAuthConfigured && (
    workResult.connectorStates.gmail === 'connected' ||
    workResult.connectorStates['google-drive'] === 'connected'
  ))
) {
  throw new Error(`Work Mode backend smoke failed: ${JSON.stringify(workResult)}`)
}

const previewConversationId = await evaluate(`
  const conversation = await window.omnicode.work.conversations.create({ title: 'Connector card smoke', provider: 'google', modelId: 'gemini-test' })
  await window.omnicode.work.conversations.addMessage(conversation.id, {
    role: 'assistant', content: 'Here are the connector results.', status: 'complete',
    toolActivities: [
      {
        id: 'smoke-mail-card', toolId: 'gmail.search', connectorId: 'gmail', name: 'Search Gmail', status: 'succeeded', createdAt: Date.now(),
        summary: 'Search Gmail completed.',
        preview: { kind: 'gmail-messages', label: 'Gmail results', count: 6, truncated: true, items: [{ title: 'Launch plan', subtitle: 'Alex', detail: 'The release candidate is ready.', metadata: 'Today' }] }
      },
      {
        id: 'smoke-drive-card', toolId: 'drive.search', connectorId: 'google-drive', name: 'Search Google Drive', status: 'succeeded', createdAt: Date.now(),
        summary: 'Search Google Drive completed.',
        preview: { kind: 'drive-files', label: 'Google Drive results', count: 1, items: [{ title: 'Resume.pdf', subtitle: 'application/pdf', metadata: '2 KB' }] }
      }
    ]
  })
  return conversation.id
`)
await evaluate(`setTimeout(() => location.reload(), 0); return true`)
await waitFor(`document.querySelector('.work-mode-host')?.getAttribute('aria-hidden') === 'false' && document.querySelectorAll('.work-result-preview').length === 2`)
const resultPreviews = await evaluate(`return {
  cards: document.querySelectorAll('.work-result-preview').length,
  gmail: document.querySelector('[aria-label="Gmail results"]')?.textContent,
  drive: document.querySelector('[aria-label="Google Drive results"]')?.textContent,
  leakedInternalId: document.body.innerText.includes('private-drive-id') || document.body.innerText.includes('internal-message-id')
}`)
if (
  resultPreviews.cards !== 2 || !resultPreviews.gmail?.includes('Launch plan') ||
  !resultPreviews.drive?.includes('Resume.pdf') || resultPreviews.leakedInternalId
) throw new Error(`Work connector result-card smoke failed: ${JSON.stringify(resultPreviews)}`)

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

await evaluate(`await window.omnicode.work.conversations.delete(${JSON.stringify(previewConversationId)}); return true`)

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
console.log(JSON.stringify({ surface, reducedMotion, stress, workResult, resultPreviews, liveGoogle, screenshotPath, runtimeErrors: unexpectedErrors }, null, 2))
