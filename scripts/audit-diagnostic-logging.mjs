import { promises as fs } from 'node:fs'
import path from 'node:path'

const port = Number(process.argv[2] ?? 9390)
const profile = await fs.realpath(process.argv[3] ?? '')
const workspace = await fs.realpath(process.argv[4] ?? '')
const logPath = path.join(profile, 'logs', 'omnicode.jsonl')
const syntheticArgument = '/tmp/sk-diagnostic-test-secret-123456789'

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
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
let nextId = 1
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data))
  if (!message.id) return
  const operation = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) operation?.reject(new Error(message.error.message))
  else operation?.resolve(message.result)
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
  await waitFor(async () => Boolean(await evaluate(`return window.omnicode && document.readyState === 'complete'`).catch(() => false)), 'OmniCode renderer bridge')
  await evaluate(`await window.omnicode.workspace.reopenWorkspace(${JSON.stringify(workspace)}); return true`)
  const visibleFailure = await evaluate(`
    try {
      await window.omnicode.workspace.readFile(${JSON.stringify(syntheticArgument)})
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  `)
  if (!/outside|workspace|authorized/iu.test(visibleFailure)) throw new Error(`Unexpected boundary failure: ${visibleFailure}`)

  let records
  await waitFor(async () => {
    const data = await fs.readFile(logPath, 'utf8')
    records = data.trim().split('\n').map((line) => JSON.parse(line))
    return records.some((record) => record.operation === 'workspace:read-file')
  }, 'persistent IPC failure record')
  const fileBytes = await fs.readFile(logPath)
  if (fileBytes.includes(Buffer.from(syntheticArgument))) throw new Error('The diagnostic log captured a sensitive IPC argument.')
  if (fileBytes.toString('utf8').includes('Authorization: Bearer')) throw new Error('The diagnostic log contains an authorization header.')
  const boundary = records.filter((record) => record.operation === 'workspace:read-file').at(-1)
  if (boundary.subsystem !== 'workspace' || !['permission', 'validation'].includes(boundary.category) || boundary.level !== 'error') {
    throw new Error(`Unexpected diagnostic record: ${JSON.stringify(boundary)}`)
  }
  const ready = records.some((record) => record.operation === 'ready' && record.category === 'lifecycle')
  if (!ready) throw new Error('The packaged startup lifecycle record is missing.')
  const mode = (await fs.stat(logPath)).mode & 0o777
  if (mode !== 0o600) throw new Error(`Diagnostic log mode is ${mode.toString(8)}, expected 600.`)

  console.log(JSON.stringify({
    packagedFailureRecorded: true,
    userFacingErrorPreserved: true,
    operation: boundary.operation,
    subsystem: boundary.subsystem,
    category: boundary.category,
    lifecycleReadyRecorded: ready,
    ipcArgumentsExcluded: true,
    authorizationHeadersAbsent: true,
    logMode: mode.toString(8)
  }, null, 2))
} finally {
  socket.close()
}
