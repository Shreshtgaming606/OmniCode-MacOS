const port = Number(process.argv[2] ?? 9470)

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
  const targets = await fetch(`http://127.0.0.1:${port}/json`)
    .then((response) => response.json())
    .catch(() => [])
  target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  return Boolean(target)
}, 'packaged OmniCode renderer')

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
  const response = await call('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  }
  return response.result.value
}

try {
  await waitFor(
    async () => Boolean(await evaluate('return Boolean(window.omnicode?.work?.tools)').catch(() => false)),
    'OmniCode Work API'
  )
  const summary = await evaluate(`
    const connectors = await window.omnicode.work.connectors.list(true)
    const gmail = connectors.find((connector) => connector.id === 'gmail')
    const drive = connectors.find((connector) => connector.id === 'google-drive')
    if (gmail?.status?.state !== 'connected' || drive?.status?.state !== 'connected') {
      throw new Error('The shared Google account is not connected.')
    }
    const labels = await window.omnicode.work.tools.execute({
      toolId: 'gmail.labels',
      mode: 'work',
      input: {}
    })
    const driveProbe = await window.omnicode.work.tools.execute({
      toolId: 'drive.search',
      mode: 'work',
      input: { query: '__omnicode_nonexistent_live_probe__', maximum: 1 }
    })
    return {
      sharedAccountConnected: true,
      gmailReadSucceeded: Array.isArray(labels.result),
      gmailLabelCount: Array.isArray(labels.result) ? labels.result.length : -1,
      driveReadSucceeded: Array.isArray(driveProbe.result?.files),
      driveResultCount: Array.isArray(driveProbe.result?.files) ? driveProbe.result.files.length : -1
    }
  `)
  if (!summary.gmailReadSucceeded || !summary.driveReadSucceeded) {
    throw new Error('A Google Workspace read probe returned an invalid result.')
  }
  console.log(JSON.stringify(summary, null, 2))
} finally {
  socket.close()
}
