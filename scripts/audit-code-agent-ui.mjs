const port = Number(process.argv[2] ?? 9550)

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
    runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'Runtime exception')
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
  const response = await call('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

try {
  await call('Runtime.enable')
  await call('Log.enable')
  const result = await evaluate(`
    const tasks = await window.omnicode.agent.list()
    const completedIndex = tasks.findIndex((task) => task.status === 'completed' && task.resultSummary)
    if (completedIndex < 0) throw new Error('No completed Code Agent task is available for UI inspection.')
    ;[...document.querySelectorAll('.ai-mode-toggle button')].find((button) => button.textContent === 'Chat')?.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
    ;[...document.querySelectorAll('.ai-mode-toggle button')].find((button) => button.textContent === 'Agent')?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const taskButtons = [...document.querySelectorAll('.agent-history > button')]
    taskButtons[completedIndex]?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    return {
      preferences: [...document.querySelectorAll('.agent-control-grid select')].map((item) => item.value),
      status: document.querySelector('.agent-status')?.textContent?.trim() || '',
      timeline: document.querySelectorAll('.agent-event').length,
      result: document.querySelector('.agent-final-result')?.textContent || '',
      reviewDiff: [...document.querySelectorAll('.agent-event-detail button')].some((button) => /review diff/i.test(button.textContent || '')),
      hiddenReasoningClaim: /chain.of.thought|hidden reasoning/i.test(document.querySelector('.agent-live-task')?.textContent || '')
    }
  `)
  if (result.preferences[1] !== 'glasses' || result.preferences[2] !== 'never') throw new Error(`Glasses preferences were not restored: ${JSON.stringify(result)}`)
  if (result.status !== 'completed' || result.timeline < 3 || !result.result || !result.reviewDiff || result.hiddenReasoningClaim) {
    throw new Error(`Completed Glasses timeline is incomplete: ${JSON.stringify(result)}`)
  }
  const errors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({ ...result, runtimeErrors: errors }, null, 2))
} finally {
  socket.close()
}
