import { promises as fs } from 'node:fs'
import path from 'node:path'

const port = Number(process.argv[2] ?? 9442)
const workspace = await fs.realpath(process.argv[3] ?? '')
const marker = path.join(workspace, 'code-agent-live.txt')

async function waitFor(check, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

let target
await waitFor(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
  target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  return Boolean(target)
}, 'packaged renderer', 30_000)

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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

let taskId
try {
  await call('Runtime.enable')
  await call('Log.enable')
  await waitFor(() => evaluate(`return Boolean(window.omnicode && (document.querySelector('.app-shell') || document.querySelector('.onboarding')))`), 'OmniCode shell', 30_000)
  if (await evaluate(`return Boolean(document.querySelector('.onboarding'))`)) {
    await evaluate(`localStorage.setItem('omnicode.onboardingComplete', 'true'); location.reload(); return true`).catch(() => undefined)
    await waitFor(() => evaluate(`return Boolean(window.omnicode && document.querySelector('.app-shell'))`), 'post-onboarding shell', 30_000)
  }
  await waitFor(() => evaluate(`return window.omnicode.workspace.readTree(${JSON.stringify(workspace)}).then(() => true).catch(() => false)`), 'workspace authorization', 30_000)
  await fs.rm(marker, { force: true })
  const result = await evaluate(`
    await window.omnicode.agent.setPreferences('glasses', 'never')
    const catalog = await window.omnicode.ai.cloudModelCatalog('google', { forceRefresh: true })
    const model = catalog.models.find((item) => item.id === 'gemini-3.6-flash')?.id
      || catalog.models.find((item) => item.availability !== 'unavailable' && item.capabilities?.toolUse?.support !== 'unsupported')?.id
      || catalog.models.find((item) => item.availability !== 'unavailable')?.id
    if (!model) throw new Error('No available Google model was returned.')
    const task = await window.omnicode.agent.start({
      provider: 'google', model, workspaceRoot: ${JSON.stringify(workspace)}, approvalMode: 'full', visibility: 'glasses', focusBehavior: 'never',
      task: 'Inspect source.txt. Create code-agent-live.txt containing exactly: OMNICODE_CODE_AGENT_LIVE_OK followed by one newline. Then read the created file and finish. Do not change any other file and do not run a terminal command.'
    })
    return { taskId: task.id, model }
  `)
  taskId = result.taskId
  await waitFor(async () => {
    const task = await evaluate(`return await window.omnicode.agent.get(${JSON.stringify(taskId)})`)
    return ['completed', 'failed', 'stopped'].includes(task.status)
  }, 'Code Agent completion', 180_000)
  const task = await evaluate(`return await window.omnicode.agent.get(${JSON.stringify(taskId)})`)
  if (task.status !== 'completed') throw new Error(`Code Agent did not complete: ${JSON.stringify({ status: task.status, error: task.error, result: task.resultSummary })}`)
  if (await fs.readFile(marker, 'utf8') !== 'OMNICODE_CODE_AGENT_LIVE_OK\n') throw new Error('The live Code Agent did not create the exact requested file.')
  const proposal = task.events.find((event) => event.proposalId)?.proposalId
  if (!proposal) throw new Error('The live task did not expose its reviewable diff proposal.')
  const surface = await evaluate(`
    if (!document.querySelector('button[title="AI sidebar"]')?.classList.contains('active')) document.querySelector('button[title="AI sidebar"]')?.click()
    ;[...document.querySelectorAll('.ai-mode-toggle button')].find((button) => button.textContent === 'Agent')?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!document.querySelector('.agent-live-task')) {
      document.querySelector('.agent-history > button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return {
      controls: [...document.querySelectorAll('.agent-control-grid select')].map((item) => item.value),
      history: Boolean(document.querySelector('.agent-history')),
      timeline: document.querySelectorAll('.agent-event').length,
      result: document.querySelector('.agent-final-report')?.textContent || '',
      plan: document.querySelector('.agent-plan-panel')?.textContent || '',
      decisionEvents: [...document.querySelectorAll('.agent-event')].filter((item) => /decision/i.test(item.textContent || '')).length
    }
  `)
  if (surface.controls.length !== 3 || !surface.history || surface.timeline < 3 || !surface.result || !/current|next|reasoning summary/i.test(surface.plan)) throw new Error(`Glasses Mode surface is incomplete: ${JSON.stringify(surface)}`)
  await evaluate(`await window.omnicode.diff.undo(${JSON.stringify(proposal)}); await window.omnicode.agent.clearHistory(); return true`)
  await waitFor(() => fs.access(marker).then(() => false).catch(() => true), 'live marker undo', 10_000)
  const errors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({
    provider: 'google', model: result.model, status: task.status,
    fileWrite: true, fileRead: task.events.some((event) => event.toolId === 'files.read' && event.status === 'succeeded'),
    diffVisible: true, undoVerified: true, glassesSurface: surface, runtimeErrors: errors
  }, null, 2))
} finally {
  if (taskId) await evaluate(`const task = await window.omnicode.agent.get(${JSON.stringify(taskId)}).catch(() => null); if (task && ['running','pausing','paused'].includes(task.status)) await window.omnicode.agent.stop(task.id); return true`).catch(() => undefined)
  await fs.rm(marker, { force: true })
  socket.close()
}
