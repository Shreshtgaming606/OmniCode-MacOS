const port = Number(process.argv[2] ?? 9491)
const workspace = process.argv[3]
const codeProvider = process.env.OMNICODE_ACTIVITY_CODE_PROVIDER === 'google' ? 'google' : 'ollama'
if (!workspace) throw new Error('Pass the workspace path as the second argument.')

async function waitFor(check, description, timeoutMs = 300_000) {
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
  target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && item.url?.endsWith('/index.html'))
  return Boolean(target)
}, 'OmniCode renderer', 30_000)

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
  const response = await call('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
  })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

const createdTaskIds = []
let conversationId
let requestId
let baselineNotificationIds = []
try {
  await call('Runtime.enable')
  await call('Log.enable')
  await waitFor(() => evaluate('return Boolean(window.omnicode && document.querySelector(".app-shell"))'), 'application shell', 30_000)
  baselineNotificationIds = await evaluate('return (await window.omnicode.notifications.snapshot()).notifications.map((item) => item.id)')
  const environment = await evaluate(`
    await window.omnicode.workspace.reopenWorkspace(${JSON.stringify(workspace)}).catch(() => undefined)
    await window.omnicode.workspace.readTree(${JSON.stringify(workspace)})
    const models = await window.omnicode.ai.models()
    const localModel = models.find((item) => item.installed && item.id === 'qwen3.5:9b' && item.modelCapabilities?.supportsTools)
      || models.find((item) => item.installed && item.id === 'qwen3.5:4b' && item.modelCapabilities?.supportsTools)
      || models.find((item) => item.installed && item.id === 'qwen3:4b' && item.modelCapabilities?.supportsTools)
      || models.find((item) => item.installed && item.modelCapabilities?.supportsTools)
    if (!localModel) throw new Error('No installed tool-capable Ollama model is available.')
    const cloud = ${JSON.stringify(codeProvider)} === 'google'
      ? await window.omnicode.ai.cloudModelCatalog('google', { forceRefresh: true })
      : undefined
    const cloudModel = cloud?.models.find((item) => item.id === 'gemini-3.8-flash' && item.availability !== 'unavailable')
      || cloud?.models.find((item) => item.availability !== 'unavailable' && item.capabilities?.['tool-calling']?.support !== 'unsupported')
      || cloud?.models.find((item) => item.availability !== 'unavailable')
    if (${JSON.stringify(codeProvider)} === 'google' && !cloudModel) throw new Error('No Google model is available for the Code activity audit.')
    const connectors = await window.omnicode.work.connectors.list(true)
    return {
      codeProvider: ${JSON.stringify(codeProvider)},
      codeModel: ${JSON.stringify(codeProvider)} === 'google' ? cloudModel.id : localModel.id,
      workModel: localModel.id,
      gmailConnected: connectors.find((item) => item.id === 'gmail')?.status?.state === 'connected',
      driveConnected: connectors.find((item) => item.id === 'google-drive')?.status?.state === 'connected'
    }
  `)

  async function runCodeTask(task) {
    const started = await evaluate(`
      return await window.omnicode.agent.start({
        provider: ${JSON.stringify(codeProvider)}, model: ${JSON.stringify(environment.codeModel)}, workspaceRoot: ${JSON.stringify(workspace)},
        task: ${JSON.stringify(task)}, approvalMode: 'full', visibility: 'standard', focusBehavior: 'never'
      })
    `)
    createdTaskIds.push(started.id)
    await waitFor(async () => {
      const current = await evaluate(`return await window.omnicode.agent.get(${JSON.stringify(started.id)})`)
      return ['completed', 'failed', 'stopped'].includes(current.status)
    }, `Code task ${started.id}`, 420_000)
    return evaluate(`
      const task = await window.omnicode.agent.get(${JSON.stringify(started.id)})
      return {
        id: task.id, status: task.status, error: task.error || '',
        eventCount: task.events.length,
        toolIds: [...new Set(task.events.map((event) => event.toolId).filter(Boolean))],
        commands: task.events.map((event) => event.command).filter(Boolean),
        fileReads: task.events.filter((event) => event.toolId === 'files.read' && event.status === 'succeeded').map((event) => event.relativePath),
        terminalSucceeded: task.events.some((event) => (event.kind === 'terminal' || event.kind === 'test') && event.status === 'succeeded')
      }
    `)
  }

  const codeInspect = await runCodeTask('Inspect package.json and tell me the current version and available npm scripts. Do not modify any files.')
  const codeChecks = await runCodeTask('Run typecheck and the test suite and summarize the result. Do not modify any files.')

  let work
  if (environment.gmailConnected) {
    const identifiers = await evaluate(`
      const conversation = await window.omnicode.work.conversations.create({ title: 'Live activity Gmail audit', provider: 'ollama', modelId: ${JSON.stringify(environment.workModel)} })
      const user = await window.omnicode.work.conversations.addMessage(conversation.id, { role: 'user', content: 'Search my Gmail for the newest test message and tell me its subject.', status: 'complete' })
      const assistant = await window.omnicode.work.conversations.addMessage(conversation.id, { role: 'assistant', content: '', status: 'pending', toolActivities: [] })
      return { conversationId: conversation.id, assistantId: assistant.id }
    `)
    conversationId = identifiers.conversationId
    requestId = `liveactivity_${Date.now()}`
    work = await evaluate(`
      const activities = []
      let streamed = ''
      const remove = window.omnicode.work.agent.onEvent((event) => {
        if (event.requestId !== ${JSON.stringify(requestId)}) return
        if (event.type === 'delta') streamed += event.delta
        else {
          const index = activities.findIndex((item) => item.id === event.activity.id)
          if (index >= 0) activities[index] = event.activity
          else activities.push(event.activity)
        }
      })
      try {
        const response = await window.omnicode.work.agent.chat(${JSON.stringify(requestId)}, {
          provider: 'ollama', model: ${JSON.stringify(environment.workModel)}, conversationId: ${JSON.stringify(conversationId)},
          messages: [{ role: 'user', content: 'Search my Gmail for the newest test message and tell me its subject.' }]
        })
        const ordered = activities.filter(Boolean).sort((left, right) => left.createdAt - right.createdAt)
        await window.omnicode.work.conversations.updateMessage(${JSON.stringify(conversationId)}, ${JSON.stringify(identifiers.assistantId)}, {
          content: response.content || 'The live audit completed without response text.', status: response.cancelled ? 'cancelled' : 'complete',
          toolActivities: [...ordered, ...response.toolActivities.filter((activity) => !ordered.some((current) => current.id === activity.id))]
        })
        return {
          cancelled: response.cancelled === true,
          toolIds: response.toolActivities.map((activity) => activity.toolId),
          liveNames: ordered.map((activity) => activity.name),
          liveStatuses: ordered.map((activity) => activity.status),
          streamed: streamed.length > 0
        }
      } finally { remove() }
    `)
  } else {
    work = { skipped: 'Gmail is not connected.' }
  }

  await evaluate(`setTimeout(() => location.reload(), 0); return true`)
  await waitFor(() => evaluate('return Boolean(window.omnicode && document.querySelector(".app-shell"))'), 'reloaded application shell', 30_000)
  await evaluate(`
    const codeButton = [...document.querySelectorAll('.mode-switcher [role="radio"]')].find((button) => button.textContent?.includes('Code'))
    codeButton?.click()
    return true
  `)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await evaluate(`
    if (!document.querySelector('button[title="AI sidebar"]')?.classList.contains('active')) document.querySelector('button[title="AI sidebar"]')?.click()
    ;[...document.querySelectorAll('.ai-mode-toggle button')].find((button) => button.textContent === 'Agent')?.click()
    return true
  `)
  await waitFor(() => evaluate('return Boolean(document.querySelector(".agent-live-task .live-activity-card"))'), 'Code activity card', 15_000).catch(() => undefined)
  const ui = await evaluate(`
    const bell = document.querySelector('.notification-bell')
    if (!document.querySelector('.notification-panel')) bell?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    return {
      liveActivityCards: document.querySelectorAll('.live-activity-card').length,
      codeActivityVisible: Boolean(document.querySelector('.agent-live-task .live-activity-card')),
      aiSidebarVisible: Boolean(document.querySelector('.ai-sidebar')),
      aiModeButtons: [...document.querySelectorAll('.ai-mode-toggle button')].map((button) => ({ text: button.textContent, active: button.classList.contains('active') })),
      agentTaskVisible: Boolean(document.querySelector('.agent-live-task')),
      agentSurfaceText: (document.querySelector('.agent-mode')?.textContent || '').slice(0, 500),
      bellVisible: Boolean(bell),
      unreadBadge: bell?.querySelector('span')?.textContent || '',
      notificationPanel: Boolean(document.querySelector('.notification-panel')),
      filters: [...document.querySelectorAll('.notification-toolbar > div button')].map((button) => button.textContent),
      linkedNotifications: [...document.querySelectorAll('.notification-open')].filter((button) => /Code|Tests|Work/i.test(button.textContent || '')).length
    }
  `)
  const notificationSnapshot = await evaluate(`
    const snapshot = await window.omnicode.notifications.snapshot()
    return {
      count: snapshot.notifications.length,
      unreadCount: snapshot.unreadCount,
      linked: snapshot.notifications.filter((item) => item.actionTarget).length,
      newTypes: snapshot.notifications.filter((item) => !${JSON.stringify(baselineNotificationIds)}.includes(item.id)).map((item) => item.type)
    }
  `)
  const errors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  console.log(JSON.stringify({ environment, codeInspect, codeChecks, work, ui, notifications: notificationSnapshot, runtimeErrors: errors }, null, 2))
} finally {
  if (requestId) await evaluate(`await window.omnicode.work.agent.cancel(${JSON.stringify(requestId)}).catch(() => false); return true`).catch(() => undefined)
  for (const taskId of createdTaskIds) {
    await evaluate(`const task = await window.omnicode.agent.get(${JSON.stringify(taskId)}).catch(() => null); if (task && ['running','pausing','paused'].includes(task.status)) await window.omnicode.agent.stop(task.id); return true`).catch(() => undefined)
  }
  if (conversationId) await evaluate(`await window.omnicode.work.conversations.delete(${JSON.stringify(conversationId)}).catch(() => undefined); return true`).catch(() => undefined)
  await evaluate(`
    const baseline = new Set(${JSON.stringify(baselineNotificationIds)})
    const snapshot = await window.omnicode.notifications.snapshot()
    for (const notification of snapshot.notifications) if (!baseline.has(notification.id)) await window.omnicode.notifications.remove(notification.id)
    return true
  `).catch(() => undefined)
  socket.close()
}
