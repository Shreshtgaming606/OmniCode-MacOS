import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9390)
const workspace = await fs.realpath(process.argv[3] ?? '')
const markerPath = path.join(workspace, 'agent-command-ui.txt')

async function apple(expression) {
  return (await execFileAsync('/usr/bin/osascript', ['-e', expression], { timeout: 5_000 })).stdout.trim()
}
async function hasSheet() {
  return (await apple(`
    tell application "System Events" to tell process "OmniCode"
      repeat with currentWindow in windows
        if (count of sheets of currentWindow) > 0 then return true
      end repeat
    end tell
    return false
  `)) === 'true'
}
async function sheetButtons() {
  return apple(`
    tell application "System Events" to tell process "OmniCode"
      repeat with currentWindow in windows
        if (count of sheets of currentWindow) > 0 then return name of every button of sheet 1 of currentWindow
      end repeat
    end tell
    return ""
  `)
}
async function clickSheetButton(name) {
  return apple(`
    tell application "System Events" to tell process "OmniCode"
      repeat with currentWindow in windows
        if (count of sheets of currentWindow) > 0 then
          click button ${JSON.stringify(name)} of sheet 1 of currentWindow
          return true
        end if
      end repeat
    end tell
    return false
  `)
}
async function waitFor(check, description, timeoutMs = 60_000) {
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
}, 'packaged renderer target')
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
  if (response.exceptionDetails) throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\nExpression:\n${body}`)
  return response.result.value
}
async function waitForRenderer(expression, timeoutMs = 30_000) {
  await waitFor(async () => Boolean(await evaluate(`return Boolean(${expression})`).catch(() => false)), expression, timeoutMs)
}
async function setTask(value) {
  await evaluate(`
    const input = document.querySelector('#agent-task-input')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
}

let report
let markerRemoved = false
let agentTaskCleared = false
let originalSelection
try {
  await call('Runtime.enable')
  await call('Log.enable')
  await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)
  await fs.rm(markerPath, { force: true })
  await evaluate(`
  if (window.__omnicodeAgentCommandConfirm) window.confirm = window.__omnicodeAgentCommandConfirm
  window.__omnicodeAgentCommandConfirm = window.confirm
  window.confirm = () => true
  if (!document.querySelector('button[title="AI sidebar"]')?.classList.contains('active')) {
    document.querySelector('button[title="AI sidebar"]').click()
  }
  return true
  `)
  await waitForRenderer(`document.querySelector('.ai-sidebar')`)
  originalSelection = await evaluate(`return {
    provider: document.querySelector('select[aria-label="AI provider"]')?.value ?? 'ollama',
    model: document.querySelector('input[aria-label="AI model name"], select[aria-label="AI model"]')?.value ?? ''
  }`)
  await evaluate(`
  const provider = document.querySelector('select[aria-label="AI provider"]')
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(provider, 'google')
  provider.dispatchEvent(new Event('change', { bubbles: true }))
  ;[...document.querySelectorAll('.ai-mode-toggle button')].find((button) => button.textContent === 'Agent').click()
  return true
  `)
  await waitForRenderer(`document.querySelector('input[aria-label="AI model name"]')`)
  await evaluate(`
    const model = document.querySelector('input[aria-label="AI model name"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(model, 'gemini-3.5-flash-lite')
    model.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
  await waitForRenderer(`document.querySelector('#agent-task-input')`)

  const task = "Return no file changes. Suggest exactly one safe command: printf 'AGENT_COMMAND_UI_OK\\n' > agent-command-ui.txt . Its reason must be: Create a disposable workspace marker for the Agent command approval audit."
  let agent
  let transientFailures = 0
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await setTask(task)
    await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Plan & Propose Changes')).click(); return true`)
    await waitForRenderer(`document.querySelector('.agent-result') || document.querySelector('.agent-mode .inline-error') || document.querySelector('.agent-run')?.textContent.includes('Building plan')`, 10_000)
    await waitForRenderer(`(document.querySelector('.agent-result') || document.querySelector('.agent-mode .inline-error')) && document.querySelector('.agent-run')?.textContent.includes('Plan & Propose Changes')`, 120_000)
    agent = await evaluate(`return {
    error: document.querySelector('.agent-mode .inline-error')?.textContent ?? '',
    summary: document.querySelector('.agent-result header')?.textContent?.trim() ?? '',
    commands: [...document.querySelectorAll('.agent-commands article')].map((article) => ({
      command: article.querySelector('code')?.textContent?.trim() ?? '',
      reason: article.querySelector('small')?.textContent?.trim() ?? '',
      button: article.querySelector('button')?.textContent?.trim() ?? ''
    })),
    noChanges: document.querySelector('.agent-no-changes')?.textContent?.trim() ?? '',
    diffVisible: Boolean(document.querySelector('.diff-review'))
    }`)
    if (!agent.error && agent.commands.length === 1 && agent.commands[0].command.includes('agent-command-ui.txt')) break
    if (attempt === 4 || !/503|high demand|UNAVAILABLE|fetch failed|network|timed? out/iu.test(agent.error)) break
    transientFailures += 1
    await evaluate(`[...document.querySelectorAll('.ai-header-actions button')].find((button) => button.textContent === 'New Task').click(); return true`)
    await waitForRenderer(`document.querySelector('#agent-task-input') && !document.querySelector('.agent-result') && !document.querySelector('.agent-mode .inline-error')`)
    await new Promise((resolve) => setTimeout(resolve, attempt * 4_000))
  }
  if (!agent || agent.error || agent.commands.length !== 1 || !agent.commands[0].command.includes('agent-command-ui.txt') || agent.diffVisible || !agent.noChanges) {
    throw new Error(`Agent did not produce the requested safe command-only plan: ${JSON.stringify(agent)}`)
  }

  await apple('tell application "System Events" to tell process "OmniCode" to set frontmost to true')
  await evaluate(`document.querySelector('.agent-commands article button').click(); return true`)
  await waitFor(async () => (await hasSheet()) || await evaluate(`return Boolean(document.querySelector('.toast.error'))`), 'native Agent command approval sheet or a visible rejection')
  const rejection = await evaluate(`return document.querySelector('.toast.error')?.textContent?.trim() ?? ''`)
  if (rejection) throw new Error(`Agent command UI rejected the model suggestion before confirmation: ${rejection}`)
  const buttons = await sheetButtons()
  for (const expected of ['Run Command', 'Cancel']) {
    if (!buttons.includes(expected)) throw new Error(`Agent command sheet omitted ${expected}: ${buttons}`)
  }
  if (await clickSheetButton('Run Command') !== 'true') throw new Error('The native Run Command button could not be invoked.')
  await waitFor(async () => !(await hasSheet()), 'Agent command approval sheet to close')
  await waitFor(async () => await fs.readFile(markerPath, 'utf8') === 'AGENT_COMMAND_UI_OK\n', 'approved Agent UI command result', 20_000)
  await waitForRenderer(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes('[Process exited with code 0]')`, 20_000)

  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  report = {
    liveGeminiAgentPlan: true,
    commandOnlyPlan: { noFileChanges: true, suggestedCommands: 1, reviewAndRunButton: true },
    nativeApproval: { buttons: ['Run Command', 'Cancel'], accepted: true },
    terminal: { executed: true, exitCode: 0, exactFileBytes: true },
    transientFailures,
    runtimeErrors: unexpectedErrors
  }
} finally {
  try {
    await evaluate(`
      if (window.__omnicodeAgentCommandConfirm) {
        window.confirm = window.__omnicodeAgentCommandConfirm
        delete window.__omnicodeAgentCommandConfirm
      }
      ;[...document.querySelectorAll('.ai-header-actions button')].find((button) => button.textContent === 'New Task')?.click()
      return true
    `)
    if (originalSelection) {
      await evaluate(`
        const provider = document.querySelector('select[aria-label="AI provider"]')
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(provider, ${JSON.stringify(originalSelection.provider)})
        provider.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      `)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await evaluate(`
        const model = document.querySelector('input[aria-label="AI model name"], select[aria-label="AI model"]')
        if (model instanceof HTMLInputElement) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(model, ${JSON.stringify(originalSelection.model)})
          model.dispatchEvent(new Event('input', { bubbles: true }))
        } else if (model instanceof HTMLSelectElement) {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(model, ${JSON.stringify(originalSelection.model)})
          model.dispatchEvent(new Event('change', { bubbles: true }))
        }
        return true
      `)
    }
    agentTaskCleared = true
  } catch { /* the renderer may have closed during a failed audit */ }
  await fs.rm(markerPath, { force: true })
  markerRemoved = true
  socket.close()
}

report.cleanup = { markerRemoved, agentTaskCleared }
console.log(JSON.stringify(report, null, 2))
