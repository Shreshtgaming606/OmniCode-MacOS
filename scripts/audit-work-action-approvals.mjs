import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9488)
const screenshotPath = process.argv[3]

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

let target
await waitFor(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
  target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  return Boolean(target)
}, 'packaged OmniCode renderer')

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
  } else if (message.method === 'Runtime.exceptionThrown') {
    runtimeErrors.push(message.params?.exceptionDetails?.text ?? 'Runtime exception')
  } else if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
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
    expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
  })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

await call('Runtime.enable')
await call('Log.enable')
await call('Page.enable')
await waitFor(async () => evaluate('return Boolean(window.omnicode?.work?.permissions && document.querySelector(".app-shell, .onboarding"))'), 'Work permission API')
if (await evaluate('return Boolean(document.querySelector(".onboarding"))')) {
  await evaluate("localStorage.setItem('omnicode.onboardingComplete', 'true'); location.reload(); return true")
  await waitFor(async () => evaluate('return Boolean(document.querySelector(".app-shell") && window.omnicode?.work?.permissions)'), 'OmniCode shell')
}

const original = await evaluate('return await window.omnicode.work.permissions.get()')
let result
try {
  await evaluate(`
    document.querySelector('.work-activity-dialog > header button')?.click()
    document.querySelector('.settings-panel > header button')?.click()
    await window.omnicode.work.permissions.setGlobal('ask')
    for (const id of Object.keys((await window.omnicode.work.permissions.get()).connectorOverrides)) {
      await window.omnicode.work.permissions.setConnector(id, null)
    }
    const workButton = [...document.querySelectorAll('.mode-switcher [role="radio"]')].find((button) => button.textContent?.includes('Work'))
    workButton?.click()
    return true
  `)
  await waitFor(async () => evaluate('return document.querySelector(".work-mode-host")?.getAttribute("aria-hidden") === "false"'), 'visible Work Mode')

  const selector = await evaluate(`return {
    label: document.querySelector('.work-approval-selector > summary')?.getAttribute('aria-label'),
    mode: (await window.omnicode.work.permissions.get()).globalMode,
    activityButton: Boolean([...document.querySelectorAll('.work-sidebar-footer button')].find((button) => button.textContent?.includes('Activity')))
  }`)
  if (selector.mode !== 'ask' || !selector.label?.includes('Ask for approval') || !selector.activityButton) throw new Error(`Quick selector baseline failed: ${JSON.stringify(selector)}`)

  await evaluate(`
    const selector = document.querySelector('.work-approval-selector')
    selector.querySelector('summary').click()
    ;[...selector.querySelectorAll('button')].find((button) => button.textContent?.includes('Approve for me'))?.click()
    return true
  `)
  await waitFor(async () => (await evaluate('return (await window.omnicode.work.permissions.get()).globalMode')) === 'auto', 'Approve for me persistence')

  await evaluate(`
    const selector = document.querySelector('.work-approval-selector')
    selector.querySelector('summary').click()
    ;[...selector.querySelectorAll('button')].find((button) => button.textContent?.includes('Full access'))?.click()
    return true
  `)
  await waitFor(async () => evaluate('return Boolean(document.querySelector(".work-full-access-warning"))'), 'Full access warning')
  const warning = await evaluate(`return {
    copy: document.querySelector('.work-full-access-warning')?.innerText,
    modeBeforeCancel: (await window.omnicode.work.permissions.get()).globalMode
  }`)
  await evaluate(`document.querySelector('.work-full-access-warning button')?.click(); return true`)
  await waitFor(async () => evaluate('return !document.querySelector(".work-full-access-warning")'), 'warning dismissal')
  if (!warning.copy?.includes('Hard safety boundaries stay active') || warning.modeBeforeCancel !== 'auto') throw new Error(`Full access warning failed: ${JSON.stringify(warning)}`)

  await evaluate(`
    const settings = [...document.querySelectorAll('.work-sidebar-footer button')].find((button) => button.textContent?.includes('Settings'))
    settings?.click()
    return true
  `)
  await waitFor(async () => evaluate('return Boolean(document.querySelector(".settings-panel #work-mode"))'), 'Work settings')
  await waitFor(async () => (await evaluate('return document.querySelectorAll(".settings-connector-approval select").length')) === 3, 'connector permission overrides')
  const settingsSurface = await evaluate(`return {
    globalChoices: document.querySelectorAll('.work-permission-options button').length,
    connectorOverrides: document.querySelectorAll('.settings-connector-approval select').length,
    title: document.querySelector('.work-permission-heading')?.textContent
  }`)
  if (settingsSurface.globalChoices !== 3 || settingsSurface.connectorOverrides !== 3 || !settingsSurface.title?.includes('How should')) throw new Error(`Settings approval surface failed: ${JSON.stringify(settingsSurface)}`)
  await evaluate(`document.querySelector('.settings-panel > header button')?.click(); return true`)

  const connectorOverride = await evaluate(`
    const updated = await window.omnicode.work.permissions.setConnector('gmail', 'ask')
    return updated.connectorOverrides.gmail
  `)
  if (connectorOverride !== 'ask') throw new Error('Connector-specific approval override did not persist.')

  const googleState = await evaluate(`
    const connectors = await window.omnicode.work.connectors.list(true)
    return connectors.find((connector) => connector.id === 'gmail')?.status?.state
  `)
  let readResult = { skipped: true }
  let cancelledSend = { skipped: true }
  if (googleState === 'connected') {
    readResult = await evaluate(`
      const value = await window.omnicode.work.tools.execute({ toolId: 'gmail.labels', mode: 'work', input: {} })
      return { success: Array.isArray(value.result), approval: value.authorization }
    `)
    if (!readResult.success || readResult.approval.requiredApproval) throw new Error(`Read action policy failed: ${JSON.stringify(readResult)}`)

    const marker = 'OmniCode approval test ' + Date.now()
    await evaluate(`
      window.__omnicodeApprovalOutcome = 'pending'
      window.omnicode.work.tools.execute({
        toolId: 'gmail.send', mode: 'work', input: {
          to: ['recipient@example.invalid'], subject: ${JSON.stringify('OMNICODE_SUBJECT_MARKER')}, body: ${JSON.stringify('OMNICODE_BODY_MARKER')}
        }
      }).then(() => { window.__omnicodeApprovalOutcome = 'unexpected-success' }).catch((error) => { window.__omnicodeApprovalOutcome = String(error?.message ?? error) })
      return ${JSON.stringify('started')}
    `)
    await waitFor(async () => evaluate('return Boolean(document.querySelector(".work-approval-card"))'), 'Gmail approval card')
    const card = await evaluate(`return {
      text: document.querySelector('.work-approval-card')?.innerText,
      approveButtons: [...document.querySelectorAll('.work-approval-card button')].map((button) => button.textContent?.trim())
    }`)
    if (!card.text?.includes('Gmail') || !card.text?.includes('recipient@example.invalid') || !card.text?.includes('OMNICODE_SUBJECT_MARKER') || !card.text?.includes('OMNICODE_BODY_MARKER') || !card.approveButtons.includes('Approve once')) {
      throw new Error(`Approval card omitted important parameters: ${JSON.stringify(card)}`)
    }
    if (screenshotPath) {
      const cardScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const cardPath = screenshotPath.replace(/\.png$/iu, '-card.png')
      await fs.writeFile(cardPath, Buffer.from(cardScreenshot.data, 'base64'))
    }
    await evaluate(`document.querySelector('.work-approval-card button')?.click(); return true`)
    await waitFor(async () => (await evaluate('return window.__omnicodeApprovalOutcome')) !== 'pending', 'cancelled approval result')
    const outcome = await evaluate('return window.__omnicodeApprovalOutcome')
    if (!/cancelled/iu.test(outcome)) throw new Error(`Cancelled action reported an unexpected result: ${outcome}`)
    const history = await evaluate(`return await window.omnicode.work.activity.list(10)`)
    const entry = history.find((item) => item.toolId === 'gmail.send')
    if (!entry || entry.result !== 'cancelled' || entry.approval !== 'user-cancelled') throw new Error(`Cancelled action history failed: ${JSON.stringify(entry)}`)
    cancelledSend = { cardRendered: true, cancelled: true, historyRecorded: true, marker }
  }

  await evaluate(`
    const activity = [...document.querySelectorAll('.work-sidebar-footer button')].find((button) => button.textContent?.includes('Activity'))
    activity?.click()
    return true
  `)
  await waitFor(async () => evaluate('return Boolean(document.querySelector(".work-activity-dialog"))'), 'Work activity dialog')
  const activitySurface = await evaluate(`return {
    title: document.querySelector('.work-activity-dialog h2')?.textContent,
    containsSecretFields: /access token|refresh token|authorization header|password/iu.test(document.querySelector('.work-activity-dialog')?.innerText ?? '')
  }`)
  if (activitySurface.title !== 'Work activity' || activitySurface.containsSecretFields) throw new Error(`Activity surface failed: ${JSON.stringify(activitySurface)}`)

  result = { selector, warning: { safeBoundariesShown: true, cancellationPreservedMode: true }, settingsSurface, connectorOverride, googleState, readResult, cancelledSend, activitySurface }
} finally {
  await evaluate(`
    const original = ${JSON.stringify(original)}
    const current = await window.omnicode.work.permissions.get()
    for (const id of new Set([...Object.keys(current.connectorOverrides), ...Object.keys(original.connectorOverrides)])) {
      await window.omnicode.work.permissions.setConnector(id, original.connectorOverrides[id] ?? null, original.connectorOverrides[id] === 'full')
    }
    await window.omnicode.work.permissions.setGlobal(original.globalMode, original.globalMode === 'full')
    return true
  `).catch(() => undefined)
}

if (screenshotPath) {
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
}
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Packaged renderer logged errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({ ...result, screenshotPath, runtimeErrors: unexpectedErrors }, null, 2))
