import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9352)
const root = await fs.realpath(process.argv[3] ?? '')
const mode = process.argv[4] ?? 'verify'

async function rendererTarget() {
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

const target = await rendererTarget()
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
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const absolute = (relativePath) => `${root}/${relativePath}`

await call('Runtime.enable')
await call('Log.enable')
await waitFor(`window.omnicode && document.querySelector('.app-shell')`)
await waitFor(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(root)}`)

const baseline = await evaluate(`
  const configPath = ${JSON.stringify(absolute('config.ts'))}
  const config = await window.omnicode.workspace.readFile(configPath)
  await window.omnicode.workspace.writeFile(
    configPath,
    "export const SESSION_TTL_MINUTES = 47\\nexport const LEGACY_CITRUS_MARKER = 'citrus'\\n",
    config.modifiedAt
  )
  const index = await window.omnicode.ai.index(${JSON.stringify(root)})
  const initial = await window.omnicode.ai.contextPreview(${JSON.stringify(root)}, 'createLoginSession SESSION_TTL_MINUTES USER_TABLE LEGACY_CITRUS_MARKER')
  const current = await window.omnicode.workspace.readFile(configPath)
  await window.omnicode.workspace.writeFile(
    configPath,
    "export const SESSION_TTL_MINUTES = 47\\nexport const FRESH_VIOLET_MARKER = 'violet'\\n",
    current.modifiedAt
  )
  return { index, initial }
`)
await pause(2_500)
const refreshed = await evaluate(`return await window.omnicode.ai.contextPreview(${JSON.stringify(root)}, 'FRESH_VIOLET_MARKER')`)

if (mode === 'observe') {
  socket.close()
  console.log(JSON.stringify({ baseline, refreshed }, null, 2))
  process.exit(0)
}

if (baseline.index.fileCount < 5 || baseline.initial.some((target) => /(?:\.env|ignored\.ts)$/u.test(target))) {
  throw new Error(`Initial index was inaccurate: ${JSON.stringify(baseline)}`)
}
if (!refreshed.includes('config.ts')) {
  throw new Error(`Filesystem watcher did not refresh updated AI context: ${JSON.stringify(refreshed)}`)
}

const lifecycle = await evaluate(`
  const root = ${JSON.stringify(root)}
  const created = await window.omnicode.workspace.createEntry(root, 'fresh-service.ts', 'file')
  const empty = await window.omnicode.workspace.readFile(created)
  await window.omnicode.workspace.writeFile(created, "export const INDEX_CREATE_MARKER = 'created'\\n", empty.modifiedAt)
  return { created }
`)
await pause(2_500)
lifecycle.afterCreate = await evaluate(`return await window.omnicode.ai.contextPreview(${JSON.stringify(root)}, 'INDEX_CREATE_MARKER')`)
lifecycle.renamed = await evaluate(`return await window.omnicode.workspace.renameEntry(${JSON.stringify(absolute('fresh-service.ts'))}, 'renamed-service.ts')`)
await pause(2_500)
lifecycle.afterRename = await evaluate(`return await window.omnicode.ai.contextPreview(${JSON.stringify(root)}, 'INDEX_CREATE_MARKER')`)
await evaluate(`await window.omnicode.workspace.trashEntry(${JSON.stringify(absolute('renamed-service.ts'))}); return true`)
await pause(2_500)
lifecycle.afterDelete = await evaluate(`return await window.omnicode.ai.contextPreview(${JSON.stringify(root)}, 'INDEX_CREATE_MARKER')`)
if (!lifecycle.afterCreate.includes('fresh-service.ts')) throw new Error(`New file was absent from refreshed index: ${JSON.stringify(lifecycle)}`)
if (!lifecycle.afterRename.includes('renamed-service.ts') || lifecycle.afterRename.includes('fresh-service.ts')) throw new Error(`Renamed file was stale in the index: ${JSON.stringify(lifecycle)}`)
if (lifecycle.afterDelete.length) throw new Error(`Deleted file remained in the index: ${JSON.stringify(lifecycle)}`)

const exclusions = await evaluate(`
  const root = ${JSON.stringify(root)}
  const secret = await window.omnicode.ai.contextPreview(root, 'OMNICODE_CONTEXT_SECRET')
  const ignored = await window.omnicode.ai.contextPreview(root, 'STALE_INDEX_MARKER')
  let outsideError = ''
  try {
    await window.omnicode.ai.chat({
      provider: 'google', model: 'gemini-3.5-flash', attachedPaths: ['/etc/hosts'],
      messages: [{ role: 'user', content: 'This request must be blocked before network access.' }]
    })
  } catch (error) { outsideError = String(error) }
  return { secret, ignored, outsideError }
`)
if (exclusions.secret.length || exclusions.ignored.length || !/outside the current workspace/iu.test(exclusions.outsideError)) {
  throw new Error(`Context exclusions/boundary failed: ${JSON.stringify(exclusions)}`)
}

await evaluate(`
  window.__omnicodeAuditConfirm = ''
  window.confirm = (message) => { window.__omnicodeAuditConfirm = String(message); return true }
  const provider = document.querySelector('select[aria-label="AI provider"]')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(provider, 'google')
  provider.dispatchEvent(new Event('change', { bubbles: true }))
  return true
`)
await waitFor(`document.querySelector('input[aria-label="AI model name"]')?.value === 'gemini-3.5-flash'`)
await evaluate(`
  [...document.querySelectorAll('.ai-header-actions button')].find((button) => button.textContent === 'New Chat')?.click()
  const workspace = [...document.querySelectorAll('.context-shelf label')].find((label) => label.textContent.includes('Workspace')).querySelector('input')
  if (!workspace.checked) workspace.click()
  const prompt = document.querySelector('textarea[aria-label="Ask OmniCode"]')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'Read createLoginSession, SESSION_TTL_MINUTES, and USER_TABLE from the workspace. Respond on one line using this format and no other text: TTL=<number>; TABLE=<table value>; PREFIX=<literal prefix used by createLoginSession>')
  prompt.dispatchEvent(new Event('input', { bubbles: true }))
  prompt.closest('form').requestSubmit()
  return true
`)
await waitFor(`document.querySelector('.ai-thinking')`, 10_000)
await waitFor(`!document.querySelector('.ai-thinking')`, 120_000)
const chat = await evaluate(`
  const messages = [...document.querySelectorAll('.ai-message.assistant .message-markdown')].map((node) => node.textContent.trim())
  return {
    response: messages.at(-1) || '',
    error: document.querySelector('.ai-messages .inline-error')?.textContent || '',
    confirmation: window.__omnicodeAuditConfirm
  }
`)
if (chat.response !== 'TTL=47; TABLE=nebula_accounts; PREFIX=OMNI-AUTH' || chat.error || !/retrieved workspace files/iu.test(chat.confirmation)) {
  throw new Error(`Real workspace-context chat failed: ${JSON.stringify(chat)}`)
}

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({ baseline, refreshed, lifecycle, exclusions, chat, runtimeErrors: unexpectedErrors }, null, 2))
