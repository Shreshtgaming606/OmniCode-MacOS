import { promises as fs } from 'node:fs'
import path from 'node:path'

const port = Number(process.argv[2] ?? 9347)
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
if (!target) throw new Error('OmniCode did not expose a renderer debugging target.')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const pending = new Map()
const runtimeErrors = []
let sequence = 0
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data))
  if (message.id) {
    const operation = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) operation?.reject(new Error(message.error.message))
    else operation?.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text)
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') runtimeErrors.push(message.params.entry.text)
})
function call(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(body) {
  const result = await call('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression, timeoutMs = 20_000) {
  const timeout = Date.now() + timeoutMs
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
await call('Log.enable')
await call('Page.enable')
await waitFor('window.omnicode')
await evaluate(`
  localStorage.setItem('omnicode.onboardingComplete', 'true')
  localStorage.setItem('omnicode.appMode', 'omni')
  return true
`)
await call('Page.reload', { ignoreCache: true })
await waitFor('document.querySelector(".omni-setup") && window.omnicode', 30_000)

const setupSnapshots = []
for (let step = 0; step < 7; step++) {
  await waitFor(`document.querySelector('.omni-setup-count')?.textContent.includes('${step + 1} of 7')`)
  if (step === 3) {
    await evaluate(`return await window.omnicode.omni.settings.update({ model: { provider: 'google', modelId: 'gemini-2.5-flash' } })`)
    await waitFor(`document.querySelector('.omni-wide-field select')?.value === 'gemini-2.5-flash'`)
  }
  const snapshot = await evaluate(`return {
    step: ${step + 1},
    title: document.querySelector('.omni-setup-content h1')?.textContent ?? '',
    progressItems: document.querySelectorAll('.omni-setup-progress li').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    footerVisible: document.querySelector('.omni-setup-footer')?.getBoundingClientRect().bottom <= innerHeight + 1,
    rawCoursePanel: Boolean(document.querySelector('.omni-plan'))
  }`)
  if (snapshot.progressItems !== 7 || snapshot.horizontalOverflow || !snapshot.footerVisible || snapshot.rawCoursePanel) {
    throw new Error(`Omni setup layout failed: ${JSON.stringify(snapshot)}`)
  }
  setupSnapshots.push(snapshot)
  if (step === 0 || step === 1 || step === 6) await screenshot(`omni-setup-${step + 1}`)
  await evaluate(`document.querySelector('.omni-setup-footer .omni-primary-button')?.click(); return true`)
}

await waitFor('document.querySelector(".omni-dashboard")')
const dashboard = await evaluate(`
  const root = document.querySelector('.omni-dashboard')
  return {
    core: Boolean(root?.querySelector('.omni-core')),
    microphone: Boolean(root?.querySelector('.omni-mic-button')),
    providerControls: root?.querySelectorAll('.omni-command-controls select').length ?? 0,
    activity: Boolean(root?.querySelector('.omni-activity-panel')),
    coursePanel: Boolean(root?.querySelector('.omni-plan')),
    historyPanel: Boolean(root?.querySelector('.omni-history-drawer')),
    availabilityPanel: Boolean(root?.querySelector('.omni-availability')),
    typedInput: Boolean(root?.querySelector('.omni-compact-composer')),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth
  }
`)
if (!dashboard.core || !dashboard.microphone || dashboard.providerControls !== 4 || !dashboard.activity ||
    dashboard.coursePanel || dashboard.historyPanel || dashboard.availabilityPanel || dashboard.typedInput || dashboard.horizontalOverflow) {
  throw new Error(`Omni dashboard structure failed: ${JSON.stringify(dashboard)}`)
}
await screenshot('omni-dashboard-normal')

await evaluate(`return await window.omnicode.omni.settings.update({ showTextInput: true })`)
await waitFor('document.querySelector(".omni-compact-composer")')
const typedInputLayout = await evaluate(`
  const composer = document.querySelector('.omni-compact-composer')?.getBoundingClientRect()
  const dock = document.querySelector('.omni-voice-dock')?.getBoundingClientRect()
  return {
    visible: Boolean(composer && composer.width > 0 && composer.height > 0),
    insideDock: Boolean(composer && dock && composer.top >= dock.top && composer.bottom <= dock.bottom),
    insideViewport: Boolean(composer && composer.left >= 0 && composer.right <= innerWidth && composer.bottom <= innerHeight)
  }
`)
if (!typedInputLayout.visible || !typedInputLayout.insideDock || !typedInputLayout.insideViewport) {
  throw new Error(`Omni typed input layout failed: ${JSON.stringify(typedInputLayout)}`)
}
await evaluate(`return await window.omnicode.omni.settings.update({ showTextInput: false })`)
await waitFor('!document.querySelector(".omni-compact-composer")')

const responsive = []
for (const viewport of [{ width: 960, height: 600, name: 'minimum' }, { width: 720, height: 720, name: 'compact' }]) {
  await call('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const result = await evaluate(`return {
    width: innerWidth, height: innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    coreWidth: Math.round(document.querySelector('.omni-core')?.getBoundingClientRect().width ?? 0),
    activityVisible: Boolean(document.querySelector('.omni-activity-panel')?.getBoundingClientRect().height)
  }`)
  if (result.horizontalOverflow || result.coreWidth < 150 || !result.activityVisible) {
    throw new Error(`Omni responsive layout failed: ${JSON.stringify(result)}`)
  }
  responsive.push(result)
  await screenshot(`omni-dashboard-${viewport.name}`)
}
await call('Emulation.clearDeviceMetricsOverride')

await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
const reducedMotion = await evaluate(`return {
  orbitAnimation: getComputedStyle(document.querySelector('.orbit-one')).animationName,
  micAnimation: getComputedStyle(document.querySelector('.omni-mic-button')).animationName
}`)
if (reducedMotion.orbitAnimation !== 'none' || reducedMotion.micAnimation !== 'none') {
  throw new Error(`Reduce Motion was not honored: ${JSON.stringify(reducedMotion)}`)
}

const settings = await evaluate(`return await window.omnicode.omni.settings.get()`)
if (!settings.setupCompleted || settings.showTextInput) throw new Error(`Omni settings did not persist correctly: ${JSON.stringify(settings)}`)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/i.test(message))
if (unexpectedErrors.length) throw new Error(`Omni renderer logged errors: ${unexpectedErrors.join(' | ')}`)

socket.close()
console.log(JSON.stringify({ setupSnapshots, dashboard, responsive, reducedMotion, settings: {
  setupCompleted: settings.setupCompleted, showTextInput: settings.showTextInput,
  provider: settings.model.provider, model: settings.model.modelId
}, typedInputLayout, screenshots: screenshotDirectory, runtimeErrors: unexpectedErrors }, null, 2))
