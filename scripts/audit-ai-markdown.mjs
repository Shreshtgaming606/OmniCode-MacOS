const port = Number(process.argv[2] ?? 9390)

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
}, 'packaged renderer target')

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
async function waitForRenderer(expression, timeoutMs = 30_000) {
  await waitFor(async () => Boolean(await evaluate(`return Boolean(${expression})`).catch(() => false)), expression, timeoutMs)
}
async function setInput(selector, value) {
  await evaluate(`
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('Missing input: ' + ${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
}

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)
const credentialStored = await evaluate(`return await window.omnicode.ai.hasCredential('google')`)
if (!credentialStored) throw new Error('Google credential is not available in the isolated audit profile.')

await evaluate(`
  if (!document.querySelector('button[title="AI sidebar"]')?.classList.contains('active')) {
    document.querySelector('button[title="AI sidebar"]').click()
  }
  return true
`)
await waitForRenderer(`document.querySelector('.ai-sidebar')`)
await evaluate(`
  const provider = document.querySelector('select[aria-label="AI provider"]')
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(provider, 'google')
  provider.dispatchEvent(new Event('change', { bubbles: true }))
  const newChat = [...document.querySelectorAll('.ai-header-actions button')].find((button) => button.textContent === 'New Chat')
  newChat?.click()
  for (const input of document.querySelectorAll('.context-shelf label input')) {
    if (input.checked) input.click()
  }
  return true
`)
await waitForRenderer(`document.querySelector('input[aria-label="AI model name"]')?.value === 'gemini-3.5-flash'`)

const prompt = 'Return exactly this Markdown and no other text:\n\n## OmniCode Markdown Test\n\n- first item\n- `inline-code`\n\n```js\nconst omnicodeMarkdown = true\n```'
let rendered
let transientFailures = 0
for (let attempt = 1; attempt <= 4; attempt += 1) {
  await setInput('textarea[aria-label="Ask OmniCode"]', prompt)
  await evaluate(`document.querySelector('.ai-composer').requestSubmit(); return true`)
  await waitForRenderer(`document.querySelector('.ai-thinking')`, 10_000)
  await waitForRenderer(`!document.querySelector('.ai-thinking')`, 120_000)
  rendered = await evaluate(`return {
    heading: [...document.querySelectorAll('.ai-message.assistant .message-markdown h2')].at(-1)?.textContent?.trim() ?? '',
    listItems: [...document.querySelectorAll('.ai-message.assistant .message-markdown li')].slice(-2).map((item) => item.textContent.trim()),
    inlineCode: [...document.querySelectorAll('.ai-message.assistant .message-markdown :not(pre) > code')].at(-1)?.textContent?.trim() ?? '',
    fencedCode: [...document.querySelectorAll('.ai-message.assistant .message-markdown pre code.language-js')].at(-1)?.textContent?.trim() ?? '',
    markdownText: [...document.querySelectorAll('.ai-message.assistant .message-markdown')].at(-1)?.textContent?.trim() ?? '',
    legacyPlainPreCount: document.querySelectorAll('.ai-message.assistant > div > pre.message-plain').length,
    error: document.querySelector('.ai-messages .inline-error')?.textContent ?? ''
  }`)
  if (rendered.heading === 'OmniCode Markdown Test' && rendered.listItems.includes('first item') && rendered.inlineCode === 'inline-code' && rendered.fencedCode === 'const omnicodeMarkdown = true' && !rendered.error) break
  if (attempt === 4 || !/503|high demand|UNAVAILABLE/iu.test(rendered.error)) break
  transientFailures += 1
  await evaluate(`
    [...document.querySelectorAll('.ai-header-actions button')].find((button) => button.textContent === 'New Chat')?.click()
    return true
  `)
  await new Promise((resolve) => setTimeout(resolve, attempt * 4_000))
}

if (rendered.heading !== 'OmniCode Markdown Test' || !rendered.listItems.includes('first item') || rendered.inlineCode !== 'inline-code' || rendered.fencedCode !== 'const omnicodeMarkdown = true' || rendered.error || rendered.legacyPlainPreCount) {
  throw new Error(`Packaged Markdown rendering failed: ${JSON.stringify(rendered)}`)
}

await evaluate(`
  [...document.querySelectorAll('.ai-header-actions button')].find((button) => button.textContent === 'New Chat')?.click()
  return true
`)
await waitForRenderer(`document.querySelectorAll('.ai-message').length === 0 && document.querySelector('.ai-empty')`)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  credentialStored,
  provider: 'google',
  realProviderResponse: true,
  rendered,
  conversationCleared: true,
  transientFailures,
  runtimeErrors: unexpectedErrors
}, null, 2))
