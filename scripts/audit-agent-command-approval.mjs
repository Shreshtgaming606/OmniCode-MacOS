import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const workspace = await fs.realpath(process.argv[3] ?? '')
const acceptedFile = path.join(workspace, 'agent-approval-audit.txt')
const cancelledFile = path.join(workspace, 'agent-cancelled-audit.txt')

async function apple(expression) {
  return (await execFileAsync('/usr/bin/osascript', ['-e', expression])).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 20_000) {
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
}, 'packaged renderer')
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
  const response = await call('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\nExpression:\n${body}`)
  return response.result.value
}
async function approve(command, reason, button) {
  await apple('tell application "OmniCode" to activate')
  const decision = evaluate(`return await window.omnicode.agent.approveCommand(${JSON.stringify(workspace)}, ${JSON.stringify(command)}, ${JSON.stringify(reason)})`)
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to count sheets of window 1')) === '1',
    'native Agent command approval sheet'
  )
  const buttons = await apple('tell application "System Events" to tell process "OmniCode" to get name of every button of sheet 1 of window 1')
  for (const expected of ['Run Command', 'Cancel']) {
    if (!buttons.includes(expected)) throw new Error(`Agent confirmation is missing ${expected}: ${buttons}`)
  }
  await apple(`tell application "System Events" to tell process "OmniCode" to click button ${JSON.stringify(button)} of sheet 1 of window 1`)
  return decision
}

await call('Runtime.enable')
await call('Log.enable')
await waitFor(async () => evaluate(`return Boolean(window.omnicode && document.querySelector('.app-shell'))`), 'workbench')
await fs.rm(acceptedFile, { force: true })
await fs.rm(cancelledFile, { force: true })

const cancelledCommand = "printf 'SHOULD_NOT_EXIST\\n' > agent-cancelled-audit.txt"
const cancelled = await approve(cancelledCommand, 'Verify that declining a safe Agent command prevents execution.', 'Cancel')
if (cancelled !== false) throw new Error('Cancel returned an approved Agent command.')
if (await fs.access(cancelledFile).then(() => true).catch(() => false)) throw new Error('The cancelled Agent command changed the filesystem.')

const acceptedCommand = "printf 'AGENT_APPROVAL_OK\\n' > agent-approval-audit.txt"
const accepted = await approve(acceptedCommand, 'Write one disposable marker file inside the authorized audit workspace.', 'Run Command')
if (accepted !== true) throw new Error('Run Command did not approve the safe Agent command.')

const terminalId = await evaluate(`
  const session = await window.omnicode.terminal.create({ cwd: ${JSON.stringify(workspace)}, name: 'Approved Agent command audit' })
  window.omnicode.terminal.write(session.id, ${JSON.stringify(`${acceptedCommand}${String.fromCharCode(13)}`)})
  return session.id
`)
await waitFor(
  async () => await fs.readFile(acceptedFile, 'utf8') === 'AGENT_APPROVAL_OK\n',
  'approved command filesystem result',
  10_000
)
await evaluate(`await window.omnicode.terminal.kill(${JSON.stringify(terminalId)}); return true`)

await fs.rm(acceptedFile)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  nativeDialogButtons: ['Run Command', 'Cancel'],
  cancel: { approved: cancelled, filesystemChanged: false },
  accept: { approved: accepted, terminalExecuted: true, exactFileBytes: true },
  cleanup: { acceptedFileRemoved: true, cancelledFileAbsent: true },
  runtimeErrors: unexpectedErrors
}, null, 2))
