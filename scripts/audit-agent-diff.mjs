import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9352)
const root = await fs.realpath(process.argv[3] ?? '')
const mode = process.argv[4] ?? 'verify'
const requestedProposalId = process.argv[5]

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
const absolute = (relativePath) => `${root}/${relativePath}`

await call('Runtime.enable')
await call('Log.enable')
await waitFor(`window.omnicode && document.querySelector('.app-shell')`)
await waitFor(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(root)}`)
if (mode === 'undo') {
  if (!requestedProposalId) throw new Error('Pass the proposal ID to undo.')
  const proposal = await evaluate(`return await window.omnicode.diff.undo(${JSON.stringify(requestedProposalId)})`)
  socket.close()
  console.log(JSON.stringify({ undone: proposal.status, proposalId: proposal.id }, null, 2))
  process.exit(0)
}
await evaluate(`
  window.__omnicodeAgentProposal = null
  window.__omnicodeAgentConfirm = ''
  window.confirm = (message) => { window.__omnicodeAgentConfirm = String(message); return true }
  window.omnicode.diff.onChanged((proposal) => { window.__omnicodeAgentProposal = proposal })
  const provider = document.querySelector('select[aria-label="AI provider"]')
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(provider, 'google')
  provider.dispatchEvent(new Event('change', { bubbles: true }))
  return true
`)
await waitFor(`document.querySelector('input[aria-label="AI model name"]')?.value === 'gemini-3.5-flash'`)
await evaluate(`
  [...document.querySelectorAll('.ai-mode-toggle button')].find((button) => button.textContent === 'Agent').click()
  return true
`)
await waitFor(`document.querySelector('#agent-task-input')`)
await evaluate(`
  const task = document.querySelector('#agent-task-input')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
    task,
    'Read config.ts and database.ts. Create only agent-audit.md with a # Agent Audit heading and one sentence stating the numeric session TTL and literal user table value found in those files. Return no commands.'
  )
  task.dispatchEvent(new Event('input', { bubbles: true }))
  ;[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Plan & Propose Changes')).click()
  return true
`)
await waitFor(`window.__omnicodeAgentProposal || document.querySelector('.agent-mode .inline-error')`, 120_000)
const agent = await evaluate(`
  return {
    proposal: window.__omnicodeAgentProposal,
    error: document.querySelector('.agent-mode .inline-error')?.textContent || '',
    confirmation: window.__omnicodeAgentConfirm,
    result: document.querySelector('.agent-result')?.textContent || '',
    diffVisible: Boolean(document.querySelector('.diff-review'))
  }
`)
if (agent.error) throw new Error(`Agent failed safely but did not produce the requested plan: ${agent.error}`)
if (!agent.proposal || agent.proposal.files.length !== 1 || agent.proposal.files[0].relativePath !== 'agent-audit.md') {
  throw new Error(`Agent proposal was not the requested single-file review: ${JSON.stringify(agent)}`)
}
if (!agent.diffVisible || !/retrieved workspace files/iu.test(agent.confirmation)) {
  throw new Error(`Agent consent/review UI was incomplete: ${JSON.stringify(agent)}`)
}
await fs.access(absolute('agent-audit.md')).then(
  () => { throw new Error('Agent wrote the proposed file before diff acceptance.') },
  () => undefined
)

const accepted = await evaluate(`return await window.omnicode.diff.accept(${JSON.stringify(agent.proposal.id)}, { scope: 'all' })`)
const acceptedContent = await fs.readFile(absolute('agent-audit.md'), 'utf8')
if (accepted.status !== 'accepted' || !acceptedContent.startsWith('# Agent Audit\n') || !acceptedContent.includes('47') || !acceptedContent.includes('nebula_accounts')) {
  throw new Error(`Accepted Agent diff did not match disk: ${JSON.stringify({ accepted, acceptedContent })}`)
}
const undone = await evaluate(`return await window.omnicode.diff.undo(${JSON.stringify(agent.proposal.id)})`)
await fs.access(absolute('agent-audit.md')).then(
  () => { throw new Error('Undo did not remove the Agent-created file.') },
  () => undefined
)

const deterministic = await evaluate(`
  const root = ${JSON.stringify(root)}
  const configPath = ${JSON.stringify(absolute('config.ts'))}
  const before = await window.omnicode.workspace.readFile(configPath)
  const proposal = await window.omnicode.diff.propose({
    workspaceRoot: root,
    title: 'Deterministic rejection audit',
    changes: [{ kind: 'modify', path: 'config.ts', content: 'export const SHOULD_NOT_REACH_DISK = true\\n' }]
  })
  const stagedDisk = await window.omnicode.workspace.readFile(configPath)
  const rejected = await window.omnicode.diff.reject(proposal.id, { scope: 'all' })
  const rejectedDisk = await window.omnicode.workspace.readFile(configPath)
  let traversalError = ''
  try {
    await window.omnicode.diff.propose({
      workspaceRoot: root,
      changes: [{ kind: 'create', path: '../agent-escape.txt', content: 'blocked' }]
    })
  } catch (error) { traversalError = String(error) }
  let commandError = ''
  try {
    await window.omnicode.agent.approveCommand(root, 'echo safe && sudo whoami', 'Unsafe audit command')
  } catch (error) { commandError = String(error) }
  let outsideRootError = ''
  try {
    await window.omnicode.agent.approveCommand('/tmp', 'npm test', 'Wrong workspace')
  } catch (error) { outsideRootError = String(error) }
  return {
    unchangedBeforeAccept: stagedDisk.content === before.content,
    unchangedAfterReject: rejectedDisk.content === before.content,
    rejectedStatus: rejected.status,
    traversalError,
    commandError,
    outsideRootError
  }
`)
if (!deterministic.unchangedBeforeAccept || !deterministic.unchangedAfterReject || deterministic.rejectedStatus !== 'rejected') {
  throw new Error(`Diff rejection changed disk: ${JSON.stringify(deterministic)}`)
}
if (!/outside/iu.test(deterministic.traversalError) || !/Command blocked/iu.test(deterministic.commandError) || !/currently open folder/iu.test(deterministic.outsideRootError)) {
  throw new Error(`Agent backend boundaries failed: ${JSON.stringify(deterministic)}`)
}

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  agent: {
    proposedFiles: agent.proposal.files.map((file) => file.relativePath),
    diffVisible: agent.diffVisible,
    contextConfirmed: /retrieved workspace files/iu.test(agent.confirmation)
  },
  accepted: accepted.status,
  undone: undone.status,
  deterministic,
  runtimeErrors: unexpectedErrors
}, null, 2))
