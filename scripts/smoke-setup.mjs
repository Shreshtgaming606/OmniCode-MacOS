import { promises as fs } from 'node:fs'
import path from 'node:path'

// Run against a packaged app with a disposable --user-data-dir. This test
// never installs software, downloads models, or accesses cloud credentials.
const port = Number(process.argv[2] ?? 9335)
const screenshotDirectory = process.argv[3]
const deadline = Date.now() + 30_000
let target
while (!target && Date.now() < deadline) {
  target = await fetch(`http://127.0.0.1:${port}/json`)
    .then((response) => response.json())
    .then((targets) => targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl))
    .catch(() => undefined)
  if (!target) await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!target) throw new Error('Packaged app did not expose a renderer target.')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const pending = new Map()
const errors = []
let sequence = 0
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data))
  if (message.id) {
    const operation = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) operation?.reject(new Error(message.error.message))
    else operation?.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
})
function call(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(body) {
  const result = await call('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression) {
  const timeout = Date.now() + 20_000
  while (Date.now() < timeout) {
    if (await evaluate(`return Boolean(${expression})`).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
async function screenshot(name) {
  if (!screenshotDirectory) return
  await fs.mkdir(screenshotDirectory, { recursive: true })
  const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), Buffer.from(result.data, 'base64'))
}
await call('Runtime.enable')
await call('Page.enable')
await waitFor('window.omnicode && document.querySelector(".onboarding")')
const api = await evaluate(`
  const tools = await window.omnicode.tools.detect()
  const installs = await window.omnicode.tools.installations()
  const pulls = await window.omnicode.ai.modelPulls()
  const catalog = await window.omnicode.ai.modelCatalog()
  let invalidToolRejected = false
  try { await window.omnicode.tools.install('not-an-allowed-tool; touch /tmp/not-run') }
  catch { invalidToolRejected = true }
  return { version: await window.omnicode.app.version(), toolCount: tools.length,
    installableMissing: tools.filter((tool) => !tool.installed && tool.installable).length,
    installs, pulls, catalogCount: catalog.length, invalidToolRejected }
`)
if (!api.invalidToolRejected || !api.catalogCount || !api.toolCount || api.installs.length || api.pulls.length) {
  throw new Error(`Setup API check failed: ${JSON.stringify(api)}`)
}
const steps = []
for (let step = 1; step <= 6; step++) {
  await waitFor(`document.querySelector('.onboarding__step-count')?.textContent.includes('Step ${step} of 6')`)
  if (step === 2 || step === 3) await waitFor(`document.querySelector('.onboarding__tool-list')`)
  const snapshot = await evaluate(`return {
    step: ${step}, title: document.querySelector('.onboarding__header h1, .onboarding__header h2')?.textContent,
    installButtons: document.querySelectorAll('button[aria-label^="Install "]').length,
    modelCards: document.querySelectorAll('.onboarding__model-card').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    footerVisible: document.querySelector('.onboarding__footer').getBoundingClientRect().bottom <= innerHeight + 1
  }`)
  if (snapshot.horizontalOverflow || !snapshot.footerVisible) throw new Error(`Setup layout failed: ${JSON.stringify(snapshot)}`)
  if (step === 4 && !snapshot.modelCards) throw new Error('No downloadable model cards in local AI setup.')
  steps.push(snapshot)
  if ([2, 3, 4].includes(step)) await screenshot(`setup-step-${step}`)
  if (step === 4) {
    await call('Emulation.setDeviceMetricsOverride', { width: 960, height: 600, deviceScaleFactor: 1, mobile: false })
    await screenshot('setup-local-ai-minimum-window')
    const fits = await evaluate(`return document.documentElement.scrollWidth <= innerWidth && document.querySelector('.onboarding__footer').getBoundingClientRect().bottom <= innerHeight + 1`)
    if (!fits) throw new Error('Local AI setup overflows the supported 960 × 600 window.')
    await call('Emulation.clearDeviceMetricsOverride')
  }
  await evaluate(`document.querySelector('.onboarding__footer .onboarding__button--primary').click()`)
}
await waitFor('document.querySelector(".app-shell")')
const completed = await evaluate(`return localStorage.getItem('omnicode.onboardingComplete') === 'true'`)
if (!completed || errors.length) throw new Error(`Setup completion failed: ${JSON.stringify({ completed, errors })}`)
socket.close()
console.log(JSON.stringify({ api, steps, completed, runtimeErrors: errors, screenshotDirectory }, null, 2))
