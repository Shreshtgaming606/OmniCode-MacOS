const port = Number(process.argv[2] ?? 9352)
const permission = process.argv[3]
if (!['microphone', 'speech-recognition'].includes(permission)) {
  throw new Error('Usage: node scripts/request-omni-permission.mjs <debug-port> <microphone|speech-recognition>')
}

let target
const deadline = Date.now() + 30_000
while (!target && Date.now() < deadline) {
  target = await fetch(`http://127.0.0.1:${port}/json`)
    .then((response) => response.json())
    .then((targets) => targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && !item.url?.includes('omni-overlay.html')))
    .catch(() => undefined)
  if (!target) await new Promise((resolve) => setTimeout(resolve, 200))
}
if (!target) throw new Error(`No OmniCode renderer appeared on port ${port}.`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0
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
  const id = ++sequence
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

await call('Runtime.enable')
const response = await call('Runtime.evaluate', {
  expression: `(async () => await window.omnicode.omni.permissions.request(${JSON.stringify(permission)}))()`,
  awaitPromise: true,
  returnByValue: true
})
if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
socket.close()
console.log(JSON.stringify(response.result.value, null, 2))
