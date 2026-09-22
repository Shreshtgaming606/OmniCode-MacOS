const port = Number(process.argv[2] ?? 9333)

async function targetWhenReady() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (target) return target
      }
    } catch {
      // The unsigned package can have a long first launch while macOS checks it.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for the packaged renderer on port ${port}.`)
}

const target = await targetWhenReady()
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (!message.id) return
  const operation = pending.get(message.id)
  if (!operation) return
  pending.delete(message.id)
  if (message.error) operation.reject(new Error(message.error.message))
  else operation.resolve(message.result)
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

await call('Runtime.enable')
const original = await evaluate(`return await window.omnicode.omni.settings.get()`)
let taskId = ''

try {
  const catalog = await evaluate(`return await window.omnicode.ai.cloudModelCatalog('google', {})`)
  const eligible = catalog.models.filter((candidate) =>
    candidate.availability !== 'unavailable' && candidate.capabilities.chat.support !== 'unsupported'
  )
  const model = eligible.find((candidate) => candidate.id === 'gemini-flash-latest') ??
    eligible.find((candidate) => candidate.capabilities['tool-calling'].support === 'supported') ?? eligible[0]
  if (!model) throw new Error('No account-visible Google chat model is available for the Omni audit.')
  const modelLiteral = JSON.stringify(model.id)

  await evaluate(`return await window.omnicode.omni.settings.update({
    enabled: true,
    executionMode: 'invisible',
    voice: { spokenResponses: false },
    model: { provider: 'google', modelId: ${modelLiteral} }
  })`)

  const task = await evaluate(`return await window.omnicode.omni.tasks.start({
    provider: 'google',
    model: ${modelLiteral},
    input: 'Use the runtime.detect tool exactly once. Then report whether Node.js is installed based only on that tool result. Do not run commands, edit files, open applications, or use any other action tool.',
    activationSource: 'main-window',
    executionMode: 'invisible',
    approvalMode: 'ask'
  })`)
  taskId = task.id

  const deadline = Date.now() + 2 * 60_000
  let finished = task
  while (Date.now() < deadline) {
    finished = await evaluate(`return await window.omnicode.omni.tasks.get(${JSON.stringify(taskId)})`)
    if (['completed', 'failed', 'stopped'].includes(finished.status)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (finished.status !== 'completed') {
    throw new Error(`The real Omni tool task did not complete: ${JSON.stringify({
      status: finished.status,
      error: finished.error,
      events: finished.events?.map((event) => ({ toolId: event.toolId, status: event.status, summary: event.summary }))
    })}`)
  }
  const runtimeEvents = finished.events.filter((event) => event.toolId === 'runtime.detect')
  if (runtimeEvents.filter((event) => event.status === 'succeeded').length !== 1 ||
      runtimeEvents.some((event) => event.status === 'failed' || event.status === 'cancelled')) {
    throw new Error(`The task did not complete exactly one successful runtime detection: ${JSON.stringify(runtimeEvents)}`)
  }
  const otherActionTools = finished.events.filter((event) =>
    event.toolId && event.toolId !== 'runtime.detect' && event.toolId !== 'omni.update-plan'
  )
  if (otherActionTools.length) throw new Error(`The task used an unexpected action tool: ${JSON.stringify(otherActionTools)}`)

  console.log(JSON.stringify({
    invisibleToolAudit: 'passed',
    model: model.id,
    taskStatus: finished.status,
    runtimeToolSuccesses: 1,
    unexpectedActionTools: 0,
    resultSummary: finished.resultSummary
  }, null, 2))
} finally {
  if (taskId) {
    await evaluate(`
      const task = await window.omnicode.omni.tasks.get(${JSON.stringify(taskId)})
      if (!['completed', 'failed', 'stopped'].includes(task.status)) await window.omnicode.omni.tasks.stop(task.id)
      return true
    `).catch(() => undefined)
  }
  await evaluate(`return await window.omnicode.omni.settings.update(${JSON.stringify(original)}, ${original.approvalMode === 'full'})`)
    .catch(() => undefined)
  socket.close()
}
