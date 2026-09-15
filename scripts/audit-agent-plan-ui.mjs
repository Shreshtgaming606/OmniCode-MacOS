import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const appBinary = await fs.realpath(process.argv[2] ?? '')
const profile = await fs.realpath(process.argv[3] ?? '')
const workspace = await fs.realpath(process.argv[4] ?? '')
const debuggingPort = Number(process.argv[5] ?? 9461)
const ollamaPort = 11_434
const model = 'qwen2.5-coder:7b'

if (!appBinary.includes('.app/Contents/MacOS/') || !Number.isInteger(debuggingPort)) {
  throw new Error('Usage: node scripts/audit-agent-plan-ui.mjs <app-binary> <profile> <workspace> [debugging-port]')
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(check, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await wait(120)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function response(reply, statusCode, value) {
  reply.writeHead(statusCode, { 'Content-Type': 'application/json' })
  reply.end(JSON.stringify(value))
}

let chatTurns = 0
let planToolName = ''
let diagnosticToolName = ''
const ollama = createServer(async (request, reply) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${ollamaPort}`).pathname
  if (pathname === '/api/version') return response(reply, 200, { version: '0.99.0-omnicode-audit' })
  if (pathname === '/api/tags') return response(reply, 200, { models: [{ name: model, model, size: 4_000_000_000, digest: 'audit', details: { family: 'qwen2', parameter_size: '7B', quantization_level: 'Q4_K_M' } }] })
  if (pathname === '/api/ps') return response(reply, 200, { models: [] })
  if (pathname !== '/api/chat') return response(reply, 404, { error: 'Not found in controlled audit service.' })

  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const tools = Array.isArray(body.tools) ? body.tools : []
  planToolName ||= tools.find((tool) => /user-visible task plan/iu.test(tool?.function?.description ?? ''))?.function?.name ?? ''
  diagnosticToolName ||= tools.find((tool) => /installed runtimes and compilers/iu.test(tool?.function?.description ?? ''))?.function?.name ?? ''
  if (!planToolName || !diagnosticToolName) return response(reply, 400, { error: 'The required Agent audit tools were not supplied to the local model.' })
  chatTurns += 1
  if (chatTurns === 1) {
    await wait(4_000)
    return response(reply, 200, {
      done_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { name: planToolName, arguments: {
        updateType: 'initial', taskUnderstanding: 'Run the controlled Agent plan audit',
        reasoningSummary: 'This first proposal intentionally becomes stale when the user intervenes.',
        steps: ['Run the stale action', 'Finish'], completedSteps: 0, currentStep: 'Run the stale action', nextStep: 'Finish'
      } } }] }
    })
  }
  if (chatTurns === 2) {
    return response(reply, 200, {
      done_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { name: planToolName, arguments: {
        updateType: 'changed', taskUnderstanding: 'Run the controlled Agent plan audit without installing dependencies',
        reasoningSummary: 'The user skipped the original step and prohibited dependency installation, so the remaining work is limited to safe built-in verification.',
        steps: ['Respect the revised scope', 'Finish controlled verification'], completedSteps: 0,
        currentStep: 'Respect the revised scope', nextStep: 'Finish controlled verification',
        decision: 'Use only the existing application and controlled local service.',
        assumptions: ['The disposable workspace is safe for this UI-only audit.'],
        changeReason: 'The user skipped the current step and requested no dependency installation.'
      } } }] }
    })
  }
  if (chatTurns === 3) {
    return response(reply, 200, {
      done_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { name: diagnosticToolName, arguments: {} } }] }
    })
  }
  if (chatTurns === 4) {
    return response(reply, 200, {
      done_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { name: planToolName, arguments: {
        updateType: 'progress', taskUnderstanding: 'Run the controlled Agent plan audit without installing dependencies',
        reasoningSummary: 'The revised scope was honored and the plan controls completed without executing the stale proposal.',
        steps: ['Respect the revised scope', 'Finish controlled verification'], completedSteps: 2,
        currentStep: 'Controlled verification complete', nextStep: 'Show the final task report',
        decision: 'The stale action remained unexecuted; finish with the recorded evidence.'
      } } }] }
    })
  }
  return response(reply, 200, { done_reason: 'stop', message: { content: 'Controlled Agent plan UI audit completed.' } })
})

await new Promise((resolve, reject) => {
  ollama.once('error', reject)
  ollama.listen(ollamaPort, '127.0.0.1', resolve)
})

const child = spawn(appBinary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${debuggingPort}`, workspace], { stdio: ['ignore', 'ignore', 'pipe'] })
const stderr = []
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { if (stderr.join('').length < 100_000) stderr.push(String(chunk)) })

let socket
let taskId
try {
  let target
  await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json`).then((item) => item.json()).catch(() => [])
    target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    return Boolean(target)
  }, 'packaged renderer')
  socket = new WebSocket(target.webSocketDebuggerUrl)
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
  const call = (method, params = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const evaluate = async (body) => {
    const result = await call('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }

  await call('Runtime.enable')
  await call('Log.enable')
  await call('Page.enable')
  await waitFor(() => evaluate(`return Boolean(window.omnicode && (document.querySelector('.app-shell') || document.querySelector('.onboarding')))`), 'OmniCode surface')
  if (await evaluate(`return Boolean(document.querySelector('.onboarding'))`)) {
    await evaluate(`localStorage.setItem('omnicode.onboardingComplete', 'true'); location.reload(); return true`)
  }
  await waitFor(() => evaluate(`return Boolean(window.omnicode && document.querySelector('.app-shell'))`), 'OmniCode workbench')
  await waitFor(() => evaluate(`return window.omnicode.workspace.readTree(${JSON.stringify(workspace)}).then(() => true).catch(() => false)`), 'workspace authorization')

  const started = await evaluate(`
    await window.omnicode.agent.setPreferences('glasses', 'never')
    return await window.omnicode.agent.start({
    provider: 'ollama', model: ${JSON.stringify(model)}, workspaceRoot: ${JSON.stringify(workspace)}, approvalMode: 'ask', visibility: 'glasses', focusBehavior: 'never',
    task: 'Complete the controlled Agent plan UI audit. Do not modify files or run commands.'
  })`)
  taskId = started.id
  await evaluate(`
    if (!document.querySelector('button[title="AI sidebar"]')?.classList.contains('active')) document.querySelector('button[title="AI sidebar"]')?.click()
    ;[...document.querySelectorAll('.ai-mode-toggle button')].find((button) => button.textContent === 'Agent')?.click()
    return true
  `)
  await waitFor(() => evaluate(`return Boolean(document.querySelector('.agent-live-task .agent-plan-panel'))`), 'initial Agent plan')
  await evaluate(`
    const controls = [...document.querySelectorAll('.agent-task-controls button')]
    controls.find((button) => /skip step/i.test(button.textContent || ''))?.click()
    controls.find((button) => /modify plan/i.test(button.textContent || ''))?.click()
    return true
  `)
  await waitFor(() => evaluate(`return Boolean(document.querySelector('#agent-plan-instruction'))`), 'plan editor')
  await evaluate(`
    const input = document.querySelector('#agent-plan-instruction')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Do not install dependencies. Use the existing application only.')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
  await waitFor(() => evaluate(`return ![...document.querySelectorAll('.agent-plan-editor button')].find((button) => /update plan/i.test(button.textContent || ''))?.disabled`), 'enabled plan update')
  await evaluate(`[...document.querySelectorAll('.agent-plan-editor button')].find((button) => /update plan/i.test(button.textContent || ''))?.click(); return true`)
  await waitFor(() => evaluate(`return document.querySelector('.agent-status')?.textContent?.includes('paused')`), 'safe Agent pause', 20_000)
  await evaluate(`[...document.querySelectorAll('.agent-task-controls button')].find((button) => /^\s*resume\s*$/i.test(button.textContent || ''))?.click(); return true`)
  await waitFor(() => evaluate(`return document.querySelector('.agent-status')?.textContent?.includes('completed')`), 'controlled Agent completion', 30_000)

  const glasses = await evaluate(`return {
    text: document.querySelector('.agent-plan-panel')?.textContent || '',
    events: document.querySelectorAll('.agent-event').length,
    decisions: [...document.querySelectorAll('.agent-event')].filter((item) => /decision/i.test(item.textContent || '')).length,
    report: document.querySelector('.agent-final-report')?.textContent || '',
    overflow: document.querySelector('.agent-mode')?.scrollWidth - document.querySelector('.agent-mode')?.clientWidth,
    buttons: [...document.querySelectorAll('.agent-task-controls button')].map((button) => button.textContent?.trim())
  }`)
  if (!/Reasoning Summary|Current|Next|2 \/ 2 complete|Plan Updated|Assumptions/iu.test(glasses.text) || glasses.events < 5 || glasses.decisions < 2 || !/Final task report|What I did|Tests performed|Remaining issues/iu.test(glasses.report) || glasses.overflow > 1) {
    throw new Error(`Glasses plan surface is incomplete: ${JSON.stringify(glasses)}`)
  }
  const glassesCount = glasses.events
  await evaluate(`
    const selector = document.querySelectorAll('.agent-control-grid select')[1]
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(selector, 'standard')
    selector.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  `)
  await wait(200)
  const standard = await evaluate(`return { events: document.querySelectorAll('.agent-event').length, plan: document.querySelector('.agent-plan-panel')?.textContent || '', report: document.querySelector('.agent-final-report')?.textContent || '' }`)
  if (standard.events >= glassesCount || !standard.plan || !standard.report) throw new Error(`Standard Mode did not retain concise planning/reporting while filtering actions: ${JSON.stringify({ glassesCount, standard })}`)

  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(profile, 'agent-plan-ui.png')
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const errors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({ taskId, chatTurns, glasses, standard, screenshotPath, runtimeErrors: errors }, null, 2))
} finally {
  if (taskId && socket?.readyState === WebSocket.OPEN) {
    // The task should already be terminal; the application closes below.
  }
  socket?.close()
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  await new Promise((resolve) => ollama.close(resolve))
}
