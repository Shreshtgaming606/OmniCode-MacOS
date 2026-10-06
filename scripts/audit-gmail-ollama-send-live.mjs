const port = Number(process.argv[2] ?? 9470)
const requestedModel = process.argv[3]?.trim() ?? ''

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
}, 'OmniCode renderer')

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
    expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
  })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

try {
  await waitFor(
    async () => Boolean(await evaluate('return Boolean(window.omnicode?.work?.agent && window.omnicode?.work?.approvals)').catch(() => false)),
    'OmniCode Work agent API'
  )
  const result = await evaluate(`
    const requestedModel = ${JSON.stringify(requestedModel)}
    const connectors = await window.omnicode.work.connectors.list(true)
    const gmail = connectors.find((connector) => connector.id === 'gmail')
    if (gmail?.status?.state !== 'connected') throw new Error('The Gmail connector is not connected.')

    const models = await window.omnicode.ai.models()
    const configured = localStorage.getItem('omnicode.workModel.ollama') || (await window.omnicode.ai.modelPreferences()).selectedModel
    const model = models.find((candidate) => candidate.provider === 'ollama' && candidate.installed && candidate.id === requestedModel)
      ?? models.find((candidate) => candidate.provider === 'ollama' && candidate.installed && candidate.id === configured)
      ?? models.find((candidate) => candidate.provider === 'ollama' && candidate.installed && candidate.toolUse)
    if (!model) throw new Error('No installed Ollama model with Work tool support is available.')
    if (requestedModel && model.id !== requestedModel) throw new Error('The requested Ollama model is not installed or does not support Work tools.')

    const policy = await window.omnicode.work.providerPolicy('ollama', model.id)
    if (!policy.allowsGoogleWorkspaceData) throw new Error('The configured Ollama model is blocked by Google Workspace provider policy.')

    const originalPermissions = await window.omnicode.work.permissions.get()
    await window.omnicode.work.permissions.setGlobal('ask')
    await window.omnicode.work.permissions.setConnector('gmail', 'ask')
    const approvals = []
    let sendApprovals = 0
    let sentTarget = ''
    let sentSubject = ''
    const unsubscribe = window.omnicode.work.approvals.onRequest(async (request) => {
      const detail = Object.fromEntries(request.details.map((entry) => [entry.label, entry.value]))
      const isGmailCompose = ['gmail.draft', 'gmail.send', 'gmail.send-draft'].includes(request.toolId)
      const isSend = request.toolId === 'gmail.send' || request.toolId === 'gmail.send-draft'
      const approve = isGmailCompose && (!isSend || ++sendApprovals === 1)
      approvals.push({
        toolId: request.toolId,
        approved: approve,
        to: typeof detail.To === 'string' && detail.To.includes('@') ? '[authenticated-email-resolved]' : detail.To ?? '',
        hasSubject: Boolean(detail.Subject),
        bodyLength: typeof detail.Message === 'string' ? detail.Message.length : 0
      })
      if (isSend) {
        sentTarget = detail.To ?? ''
        sentSubject = detail.Subject ?? ''
      }
      await window.omnicode.work.approvals.resolve(request.id, approve)
    })
    try {
      const requestId = crypto.randomUUID()
      const response = await window.omnicode.work.agent.chat(requestId, {
        provider: 'ollama',
        model: model.id,
        messages: [{ role: 'user', content: 'draft an email to myself explaining how a computer works then send it' }]
      })
      let sentVerification = { found: false }
      if (response.toolActivities.some((activity) => activity.toolId === 'gmail.send' && activity.status === 'succeeded') && sentTarget && sentSubject) {
        const safeSubject = sentSubject.split('"').join(' ').split(String.fromCharCode(92)).join(' ').trim()
        for (let attempt = 0; attempt < 10; attempt++) {
          const found = await window.omnicode.work.tools.execute({
            toolId: 'gmail.search', mode: 'work',
            input: { query: 'in:sent to:' + sentTarget + ' subject:"' + safeSubject + '" newer_than:1d', maximum: 5 }
          })
          const match = Array.isArray(found.result?.messages)
            ? found.result.messages.find((message) => message.subject === sentSubject && message.to?.includes(sentTarget))
            : undefined
          if (match?.id) {
            const read = await window.omnicode.work.tools.execute({
              toolId: 'gmail.read', mode: 'work', input: { messageId: match.id }
            })
            sentVerification = {
              found: true,
              messageId: match.id,
              recipientMatches: read.result?.to?.includes(sentTarget) === true,
              subjectPresent: typeof read.result?.subject === 'string' && read.result.subject.length > 0,
              bodyPresent: typeof read.result?.body === 'string' && read.result.body.trim().length > 0,
              sentLabelPresent: Array.isArray(read.result?.labels) && read.result.labels.includes('SENT')
            }
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
      }
      return {
        model: model.id,
        approvals,
        toolCallCount: response.toolCallCount,
        toolActivities: response.toolActivities.map((activity) => ({
          toolId: activity.toolId,
          status: activity.status,
          summary: activity.summary,
          errorCode: activity.errorCode
        })),
        responseReportedSuccess: /(?:sent|success)/iu.test(response.content),
        sentVerification
      }
    } finally {
      unsubscribe()
      const current = await window.omnicode.work.permissions.get()
      for (const id of new Set([...Object.keys(current.connectorOverrides), ...Object.keys(originalPermissions.connectorOverrides)])) {
        await window.omnicode.work.permissions.setConnector(id, originalPermissions.connectorOverrides[id] ?? null, originalPermissions.connectorOverrides[id] === 'full')
      }
      await window.omnicode.work.permissions.setGlobal(originalPermissions.globalMode, originalPermissions.globalMode === 'full')
    }
  `)
  console.log(JSON.stringify(result, null, 2))
} finally {
  socket.close()
}
