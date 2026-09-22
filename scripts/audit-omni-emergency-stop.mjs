import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const port = Number(process.argv[2] ?? 9333)
const helperPath = process.argv[3]

if (!helperPath) {
  throw new Error('Usage: node scripts/audit-omni-emergency-stop.mjs <debug-port> <packaged-helper-path>')
}

async function targetWhenReady() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (target) return target
      }
    } catch {
      // The packaged renderer may still be starting.
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

async function pressEmergencyStop() {
  const id = randomUUID()
  const request = JSON.stringify({
    version: 1,
    id,
    command: 'press-key',
    key: 'escape',
    modifiers: ['command', 'shift'],
    repeat: 1
  })
  return await new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('The packaged cursor helper timed out while sending the emergency stop.'))
    }, 10_000)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', () => {
      clearTimeout(timer)
      let response
      try { response = JSON.parse(stdout.trim()) } catch {
        reject(new Error(`The packaged cursor helper returned invalid JSON (${stderr.length} diagnostic bytes).`))
        return
      }
      if (response?.version !== 1 || response?.id !== id || response?.ok !== true) {
        reject(new Error('The packaged cursor helper rejected the emergency-stop key chord.'))
        return
      }
      resolve(response.result)
    })
    child.stdin.end(`${request}\n`, 'utf8')
  })
}

await call('Runtime.enable')
const original = await evaluate(`return await window.omnicode.omni.settings.get()`)
let taskId = ''

try {
  const catalog = await evaluate(`return await window.omnicode.ai.cloudModelCatalog('google', {})`)
  const model = catalog.models.find((candidate) =>
    candidate.availability !== 'unavailable' && candidate.capabilities.chat.support !== 'unsupported'
  )
  if (!model) throw new Error('No account-visible Google chat model is available for the emergency-stop audit.')
  const modelLiteral = JSON.stringify(model.id)

  const readiness = await evaluate(`
    await window.omnicode.omni.settings.update({
      enabled: true,
      executionMode: 'cursor',
      voice: { spokenResponses: false },
      model: { provider: 'google', modelId: ${modelLiteral} }
    })
    return await window.omnicode.omni.cursor.status()
  `)
  if (readiness.accessibility !== 'granted' || readiness.nativeHelper !== 'available' || readiness.emergencyStop !== 'registered') {
    throw new Error(`Cursor emergency-stop readiness failed: ${JSON.stringify(readiness)}`)
  }

  const task = await evaluate(`return await window.omnicode.omni.tasks.start({
    provider: 'google',
    model: ${modelLiteral},
    input: 'Respond with exactly: Omni emergency stop audit request.',
    activationSource: 'main-window',
    executionMode: 'cursor',
    approvalMode: 'ask'
  })`)
  taskId = task.id
  await pressEmergencyStop()

  const deadline = Date.now() + 10_000
  let stopped
  while (Date.now() < deadline) {
    stopped = await evaluate(`return await window.omnicode.omni.tasks.get(${JSON.stringify(taskId)})`)
    if (stopped.status === 'stopped') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (stopped?.status !== 'stopped' || stopped.resultSummary !== 'Stopped by the user.') {
    throw new Error(`The emergency shortcut did not stop the active Cursor task: ${JSON.stringify(stopped)}`)
  }

  console.log(JSON.stringify({
    emergencyStop: 'passed',
    accelerator: readiness.emergencyStopShortcut,
    taskStatus: stopped.status,
    resultSummary: stopped.resultSummary,
    model: model.id
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
