import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const originalWorkspace = await fs.realpath(process.argv[3] ?? '')

async function command(program, args, cwd) {
  return execFileAsync(program, args, { cwd, timeout: 30_000 })
}
async function apple(...expressions) {
  const args = expressions.flatMap((expression) => ['-e', expression])
  return (await execFileAsync('/usr/bin/osascript', args, { timeout: 5_000 })).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function frontmost() {
  await apple('tell application "OmniCode" to activate')
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to get frontmost')) === 'true',
    'OmniCode to become frontmost'
  )
}
async function macKeystroke(character, modifiers) {
  await frontmost()
  const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : ''
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(character)}${using}`)
}
async function keyCode(code) {
  await frontmost()
  await apple(`tell application "System Events" to key code ${code}`)
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
  if (response.exceptionDetails) throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\nExpression:\n${body}`)
  return response.result.value
}
async function waitForRenderer(expression, timeoutMs = 30_000) {
  await waitFor(async () => Boolean(await evaluate(`return Boolean(${expression})`).catch(() => false)), expression, timeoutMs)
}
async function setInput(selector, value) {
  await evaluate(`
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('Missing input: ' + ${JSON.stringify(selector)})
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
}
async function openByQuickOpen(name) {
  await macKeystroke('p', ['command down'])
  await waitForRenderer(`document.querySelector('.palette input[placeholder="Search files by name"]')`)
  await setInput('.palette input[placeholder="Search files by name"]', name)
  await waitForRenderer(`[...document.querySelectorAll('.palette-results button strong')].some((item) => item.textContent === ${JSON.stringify(name)})`)
  await evaluate(`
    const strong = [...document.querySelectorAll('.palette-results button strong')].find((item) => item.textContent === ${JSON.stringify(name)})
    strong.closest('button').click()
    return true
  `)
  await waitForRenderer(`document.querySelector('.editor-tabs button[title$="/${name}"]')?.classList.contains('active')`)
}
async function dispatchDirectoryDrop(directory) {
  const point = await evaluate(`
    const rect = document.querySelector('.app-shell').getBoundingClientRect()
    return { x: Math.round(rect.left + 20), y: Math.round(rect.top + 140) }
  `)
  const data = { items: [], files: [directory], dragOperationsMask: 1 }
  await call('Input.dispatchDragEvent', { type: 'dragEnter', x: point.x, y: point.y, data })
  await call('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data })
  await call('Input.dispatchDragEvent', { type: 'drop', x: point.x, y: point.y, data })
}
async function sendTerminal(commandText) {
  if (await evaluate(`return document.querySelector('.terminal-panel')?.hidden !== false`)) {
    await macKeystroke('`', ['command down'])
  }
  await waitForRenderer(`document.querySelector('.terminal-panel') && !document.querySelector('.terminal-panel').hidden`)
  await waitForRenderer(`document.querySelector('.terminal-panel__screen.is-active:not(.is-secondary) .xterm-helper-textarea')`)
  await frontmost()
  await evaluate(`document.querySelector('.terminal-panel__screen.is-active:not(.is-secondary) .xterm-helper-textarea').focus(); return true`)
  await apple(`tell application "System Events" to keystroke ${JSON.stringify(commandText)}`)
  await apple('tell application "System Events" to key code 36')
  await waitForRenderer(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.innerText?.includes('TERMINAL_CONTEXT_TOKEN')`)
  await evaluate(`document.querySelector('button[aria-label="Close terminal panel"]').click(); return true`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-ai-controls-'))
await fs.writeFile(path.join(fixture, 'active.ts'), `SELECTED_CONTEXT_TOKEN\nexport const CURRENT_CONTEXT_TOKEN: string = 'current'\nconst PROBLEM_CONTEXT_TOKEN: string = 42\n`)
await fs.writeFile(path.join(fixture, 'other.ts'), `export const OPEN_CONTEXT_TOKEN = 'open-file'\n`)
await fs.writeFile(path.join(fixture, 'selected-only.ts'), `export const SELECTED_FILE_CONTEXT_TOKEN = 'picked-file'\n`)
await fs.writeFile(path.join(fixture, 'GIT_CONTEXT_TOKEN.txt'), 'tracked baseline\n')
await command('/usr/bin/git', ['init', '-q'], fixture)
await command('/usr/bin/git', ['config', 'user.name', 'OmniCode Audit'], fixture)
await command('/usr/bin/git', ['config', 'user.email', 'audit@omnicode.invalid'], fixture)
await command('/usr/bin/git', ['add', '.'], fixture)
await command('/usr/bin/git', ['commit', '-qm', 'baseline'], fixture)
await fs.writeFile(path.join(fixture, 'GIT_CONTEXT_TOKEN.txt'), 'working tree change\n')
const canonicalFixture = await fs.realpath(fixture)

await dispatchDirectoryDrop(canonicalFixture)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(canonicalFixture))}`)
await openByQuickOpen('other.ts')
await openByQuickOpen('active.ts')
await waitForRenderer(`[...document.querySelectorAll('.editor-tabs button[title]')].filter((item) => !item.classList.contains('new-tab')).length >= 2`)
await waitForRenderer(`[...document.querySelectorAll('.panel-tabs button')].find((item) => item.textContent?.startsWith('problems'))?.querySelector('span')`)
await waitForRenderer(`!document.querySelector('.context-shelf label:nth-of-type(7) input')?.disabled`)

// Select exactly the first-line token in Monaco.
await frontmost()
await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
await apple('tell application "System Events" to key code 126 using command down')
await apple('tell application "System Events" to key code 124 using {command down, shift down}')
await waitForRenderer(`document.querySelectorAll('.monaco-editor .selected-text').length > 0`)

await sendTerminal("printf 'TERMINAL_CONTEXT_TOKEN\\n'")
await waitForRenderer(`!document.querySelector('.context-shelf label:nth-of-type(5) input')?.disabled`)

const originalPermission = await evaluate(`return localStorage.getItem('omnicode.agentPermission')`)
await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
await waitForRenderer(`document.querySelector('.settings-panel #permissions')`)
await evaluate(`
  const button = [...document.querySelectorAll('.permission-options button')].find((item) => item.textContent?.includes('Ask Every Time'))
  if (!button.classList.contains('active')) button.click()
  document.querySelector('.settings-panel header button[title="Close settings"]').click()
  return true
`)

await evaluate(`
  if (!document.querySelector('button[title="AI sidebar"]')?.classList.contains('active')) {
    document.querySelector('button[title="AI sidebar"]').click()
  }
  window.__omnicodeOriginalConfirm = window.confirm
  window.__omnicodeContextConfirm = ''
  window.confirm = (message) => { window.__omnicodeContextConfirm = String(message); return true }
  return true
`)
await waitForRenderer(`document.querySelector('.ai-sidebar')`)
await evaluate(`
  const provider = document.querySelector('select[aria-label="AI provider"]')
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(provider, 'google')
  provider.dispatchEvent(new Event('change', { bubbles: true }))
  const wanted = ['Selection', 'Open Files', 'Terminal', 'Problems', 'Git Changes']
  for (const label of document.querySelectorAll('.context-shelf label')) {
    const name = label.textContent.trim()
    const input = label.querySelector('input')
    if (wanted.some((item) => name.startsWith(item)) && !input.checked) input.click()
  }
  return true
`)
await waitForRenderer(`document.querySelector('input[aria-label="AI model name"]')?.value === 'gemini-3.5-flash'`)

// Attach one additional file through the real macOS file picker.
await evaluate(`document.querySelector('.context-add').click(); return true`)
await waitFor(
  async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '1',
  'AI file attachment sheet'
)
await macKeystroke('g', ['command down', 'shift down'])
await new Promise((resolve) => setTimeout(resolve, 300))
await macKeystroke(path.join(canonicalFixture, 'selected-only.ts'), [])
await keyCode(36)
await new Promise((resolve) => setTimeout(resolve, 500))
await apple('tell application "System Events" to tell process "OmniCode" to click button "Open" of sheet 1 of window 1')
await waitForRenderer(`[...document.querySelectorAll('.context-file')].some((item) => item.textContent?.includes('selected-only.ts'))`)

const prompt = 'Inspect only the attached context. Respond exactly OMNICODE_SEVEN_CONTEXTS_PASS if attached files contain CURRENT_CONTEXT_TOKEN, OPEN_CONTEXT_TOKEN, and SELECTED_FILE_CONTEXT_TOKEN; selected code contains SELECTED_CONTEXT_TOKEN; Recent terminal output contains TERMINAL_CONTEXT_TOKEN; Current problems reports the number-to-string type error; and Git changes contains GIT_CONTEXT_TOKEN.txt. Otherwise respond exactly MISSING_CONTEXT.'
let result
let transientFailures = 0
for (let attempt = 1; attempt <= 4; attempt += 1) {
  await setInput('textarea[aria-label="Ask OmniCode"]', prompt)
  await evaluate(`document.querySelector('.ai-composer').requestSubmit(); return true`)
  await waitForRenderer(`document.querySelector('.ai-message.user')`, 10_000)
  await waitForRenderer(`!document.querySelector('.ai-thinking')`, 120_000)
  result = await evaluate(`return {
    response: [...document.querySelectorAll('.ai-message.assistant .message-markdown')].at(-1)?.textContent?.trim() ?? '',
    error: document.querySelector('.ai-messages .inline-error')?.textContent ?? '',
    confirmation: window.__omnicodeContextConfirm,
    attached: [...document.querySelectorAll('.context-shelf label')].filter((label) => label.querySelector('input')?.checked).map((label) => label.textContent.trim()),
    selectedFiles: [...document.querySelectorAll('.context-file')].map((item) => item.textContent.trim())
  }`)
  if (result.response === 'OMNICODE_SEVEN_CONTEXTS_PASS' && !result.error) break
  if (attempt === 4 || !/503|high demand|UNAVAILABLE/iu.test(result.error)) break
  transientFailures += 1
  await evaluate(`
    [...document.querySelectorAll('.ai-header-actions button')].find((button) => button.textContent === 'New Chat').click()
    return true
  `)
  await new Promise((resolve) => setTimeout(resolve, attempt * 4_000))
}
if (result.response !== 'OMNICODE_SEVEN_CONTEXTS_PASS' || result.error) throw new Error(`Real all-context Gemini request failed: ${JSON.stringify(result)}`)
for (const expected of ['selected code', 'current file', 'open files', 'terminal output', 'editor problems', 'Git changes', 'selected files']) {
  if (!result.confirmation.includes(expected)) throw new Error(`Consent omitted ${expected}: ${result.confirmation}`)
}

await evaluate(`
  [...document.querySelectorAll('.ai-header-actions button')].find((button) => button.textContent === 'New Chat').click()
  return true
`)
await waitForRenderer(`document.querySelectorAll('.ai-message').length === 0 && document.querySelector('.ai-empty')`)

// Restore the isolated profile's permission and original audit workspace.
await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
await waitForRenderer(`document.querySelector('.settings-panel #permissions')`)
const originalPermissionValue = ['ask', 'workspace', 'agent'].includes(originalPermission) ? originalPermission : 'ask'
const permissionLabel = { ask: 'Ask Every Time', workspace: 'Workspace Access', agent: 'Agent Mode' }[originalPermissionValue]
await evaluate(`
  const button = [...document.querySelectorAll('.permission-options button')].find((item) => item.textContent?.includes(${JSON.stringify(permissionLabel)}))
  if (!button.classList.contains('active')) button.click()
  document.querySelector('.settings-panel header button[title="Close settings"]').click()
  if (${JSON.stringify(originalPermission)} === null) localStorage.removeItem('omnicode.agentPermission')
  else localStorage.setItem('omnicode.agentPermission', ${JSON.stringify(originalPermission)})
  window.confirm = window.__omnicodeOriginalConfirm
  delete window.__omnicodeOriginalConfirm
  return true
`)
await dispatchDirectoryDrop(originalWorkspace)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(originalWorkspace))}`)

const trashDestination = path.join(os.homedir(), '.Trash', path.basename(canonicalFixture))
await fs.rename(canonicalFixture, trashDestination)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  attachedControls: result.attached,
  selectedFiles: result.selectedFiles,
  consent: result.confirmation,
  liveGeminiResponse: result.response,
  transientProviderFailuresRetried: transientFailures,
  newChatClearedConversation: true,
  originalPermissionRestored: true,
  originalWorkspaceRestored: true,
  cleanup: { recoverableTrashPath: trashDestination },
  runtimeErrors: unexpectedErrors
}, null, 2))
