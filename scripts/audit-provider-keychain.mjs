import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9352)
let workspace = process.argv[3]
const mode = process.argv[4] ?? 'probe-and-save'
const requestedProvider = process.argv[5]
if (!workspace) throw new Error('Usage: node scripts/audit-provider-keychain.mjs <debug-port> <workspace> [probe-only|probe-and-save|verify-and-clean] [provider]')
workspace = await fs.realpath(workspace)

const providerNames = { openai: 'OpenAI', anthropic: 'Anthropic Claude', google: 'Google Gemini' }
const defaultModels = { openai: 'gpt-5', anthropic: 'claude-sonnet-5', google: 'gemini-3.5-flash' }
const providers = Object.keys(providerNames)
const temporaryKey = 'omnicode-audit-invalid-key-20260905'

async function targetWhenReady() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const target = await fetch(`http://127.0.0.1:${port}/json`)
      .then((response) => response.json())
      .then((targets) => targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl))
      .catch(() => undefined)
    if (target) return target
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`No renderer target appeared on port ${port}.`)
}

const target = await targetWhenReady()
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
  if (message.method === 'Runtime.exceptionThrown') {
    runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'Runtime exception')
  }
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
    runtimeErrors.push(message.params.entry.text)
  }
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
  if (response.exceptionDetails) {
    throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\nExpression:\n${body}`)
  }
  return response.result.value
}
async function waitFor(expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`return Boolean(${expression})`).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitFor(`window.omnicode && document.querySelector('.app-shell')`)
await waitFor(`await window.omnicode.workspace.readTree(${JSON.stringify(workspace)}).then(() => true).catch(() => false)`)

if (mode === 'probe-only' || mode === 'probe-and-save') {
  const result = await evaluate(`
    const providers = ${JSON.stringify(providers)}
    const models = ${JSON.stringify(defaultModels)}
    const stored = Object.fromEntries(await Promise.all(providers.map(async (provider) => [provider, await window.omnicode.ai.hasCredential(provider)])))
    const connections = {}
    const chats = {}
    for (const provider of providers) {
      if (!stored[provider]) continue
      const connection = await window.omnicode.ai.testProviderConnection(provider)
      connections[provider] = connection
      if (connection.state !== 'connected') continue
      try {
        const reply = await window.omnicode.ai.chat({
          provider,
          model: models[provider],
          messages: [{ role: 'user', content: 'Respond with exactly: OmniCode Cloud AI Test Successful' }]
        })
        chats[provider] = { passed: reply.content.trim() === 'OmniCode Cloud AI Test Successful', receivedText: Boolean(reply.content.trim()) }
      } catch (error) {
        chats[provider] = { passed: false, error: String(error) }
      }
    }
    return { stored, connections, chats }
  `)

  let temporary
  if (mode === 'probe-and-save') {
    await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
    await waitFor(`document.querySelector('.settings-panel') && !document.querySelector('#providers [aria-busy="true"]')`)
    const provider = providers.find((candidate) => !result.stored[candidate])
    if (provider) {
    temporary = await evaluate(`
      const provider = ${JSON.stringify(provider)}
      const name = ${JSON.stringify(providerNames[provider])}
      const input = document.querySelector('input[aria-label="' + name + ' API key"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(temporaryKey)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const started = Date.now()
      const save = document.querySelector('button[aria-label="Save ' + name + ' API key"]')
      while (save.disabled && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 50))
      save.click()
      const row = input.closest('.provider-setting')
      while (row.getAttribute('aria-busy') !== 'true' && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 50))
      while (row.getAttribute('aria-busy') === 'true' && Date.now() - started < 30000) await new Promise((resolve) => setTimeout(resolve, 100))
      const stored = await window.omnicode.ai.hasCredential(provider)
      const connection = await window.omnicode.ai.testProviderConnection(provider)
      return { provider, stored, connection, label: row.querySelector('small')?.textContent || '', status: document.querySelector('.settings-status')?.textContent || '' }
    `)
    if (!temporary.stored || temporary.connection.state === 'connected' || !/saved securely/iu.test(temporary.status)) {
      throw new Error(`Temporary provider credential did not save/test accurately: ${JSON.stringify(temporary)}`)
    }
    }
  }

  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  socket.close()
  console.log(JSON.stringify({ ...result, temporary, runtimeErrors: unexpectedErrors }, null, 2))
} else if (mode === 'verify-and-clean') {
  if (!providers.includes(requestedProvider)) throw new Error('Pass the temporary provider returned by probe-and-save.')
  const provider = requestedProvider
  const name = providerNames[provider]
  const before = await evaluate(`return await window.omnicode.ai.hasCredential(${JSON.stringify(provider)})`)
  if (!before) throw new Error(`The temporary ${provider} credential did not survive the application restart.`)

  await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
  await waitFor(`document.querySelector('button[aria-label="Test ${name} connection"]')`)
  const initialLabel = await evaluate(`return document.querySelector('input[aria-label="${name} API key"]').closest('.provider-setting').querySelector('small')?.textContent || ''`)
  if (!/stored.*not tested/iu.test(initialLabel)) throw new Error(`Restarted Settings state was inaccurate: ${initialLabel}`)

  const chatFailure = await evaluate(`
    try {
      await window.omnicode.ai.chat({
        provider: ${JSON.stringify(provider)},
        model: ${JSON.stringify(defaultModels[provider])},
        messages: [{ role: 'user', content: 'OmniCode invalid credential verification' }]
      })
      return ''
    } catch (error) { return String(error) }
  `)
  if (!/401|403|auth|API provider returned/iu.test(chatFailure)) throw new Error(`Cloud chat did not use the restarted Keychain credential: ${chatFailure}`)

  await evaluate(`document.querySelector('button[aria-label="Test ${name} connection"]').click(); return true`)
  await waitFor(`document.querySelector('input[aria-label="${name} API key"]').closest('.provider-setting').getAttribute('aria-busy') !== 'true' && /Authentication failed|Connection unavailable/iu.test(document.querySelector('input[aria-label="${name} API key"]').closest('.provider-setting').querySelector('small')?.textContent || '')`)
  const testedLabel = await evaluate(`return document.querySelector('input[aria-label="${name} API key"]').closest('.provider-setting').querySelector('small')?.textContent || ''`)
  if (!/Authentication failed|Connection unavailable/iu.test(testedLabel)) throw new Error(`Test Connection did not update provider state: ${testedLabel}`)

  await evaluate(`document.querySelector('button[title="Delete ${name} credential"]').click(); return true`)
  await waitFor(`!(await window.omnicode.ai.hasCredential(${JSON.stringify(provider)}))`)
  await waitFor(`document.querySelector('input[aria-label="${name} API key"]').closest('.provider-setting').querySelector('small')?.textContent.includes('Not configured')`)
  const after = await evaluate(`return await window.omnicode.ai.hasCredential(${JSON.stringify(provider)})`)
  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  socket.close()
  console.log(JSON.stringify({
    provider,
    survivedRestart: before,
    storedCredentialUsedByChat: true,
    chatFailureRedacted: !chatFailure.includes(temporaryKey),
    testConnectionLabel: testedLabel,
    deleted: !after,
    runtimeErrors: unexpectedErrors
  }, null, 2))
} else {
  throw new Error(`Unknown audit mode: ${mode}`)
}
