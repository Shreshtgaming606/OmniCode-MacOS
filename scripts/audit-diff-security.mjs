import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9352)
const root = await fs.realpath(process.argv[3] ?? '')
const suffix = String(Date.now())
const names = {
  keep: `diff-keep-${suffix}.txt`,
  remove: `diff-remove-${suffix}.txt`,
  created: `diff-created-${suffix}.txt`
}

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

await call('Runtime.enable')
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  if (await evaluate(`return document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(root)}`).catch(() => false)) break
  await new Promise((resolve) => setTimeout(resolve, 150))
}
if (!await evaluate(`return document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(root)}`)) {
  throw new Error('The requested workspace did not open in the packaged renderer.')
}
await evaluate(`
  const root = ${JSON.stringify(root)}
  const names = ${JSON.stringify(names)}
  for (const [name, content] of [[names.keep, 'before\\n'], [names.remove, 'restore me\\n']]) {
    const target = await window.omnicode.workspace.createEntry(root, name, 'file')
    const empty = await window.omnicode.workspace.readFile(target)
    await window.omnicode.workspace.writeFile(target, content, empty.modifiedAt)
  }
  return true
`)
const proposal = await evaluate(`return await window.omnicode.diff.propose({
  workspaceRoot: ${JSON.stringify(root)},
  title: 'Packaged transaction audit',
  changes: [
    { kind: 'modify', path: ${JSON.stringify(names.keep)}, content: 'after\\n' },
    { kind: 'create', path: ${JSON.stringify(names.created)}, content: 'new file\\n' },
    { kind: 'delete', path: ${JSON.stringify(names.remove)} }
  ]
})`)
const before = {
  keep: await fs.readFile(`${root}/${names.keep}`, 'utf8'),
  remove: await fs.readFile(`${root}/${names.remove}`, 'utf8'),
  createdExists: await fs.access(`${root}/${names.created}`).then(() => true, () => false)
}
if (before.keep !== 'before\n' || before.remove !== 'restore me\n' || before.createdExists) {
  throw new Error(`Proposal changed disk before acceptance: ${JSON.stringify(before)}`)
}

const accepted = await evaluate(`return await window.omnicode.diff.accept(${JSON.stringify(proposal.id)}, { scope: 'all' })`)
const afterAccept = {
  keep: await fs.readFile(`${root}/${names.keep}`, 'utf8'),
  removeExists: await fs.access(`${root}/${names.remove}`).then(() => true, () => false),
  created: await fs.readFile(`${root}/${names.created}`, 'utf8')
}
if (accepted.status !== 'accepted' || afterAccept.keep !== 'after\n' || afterAccept.removeExists || afterAccept.created !== 'new file\n') {
  throw new Error(`Accepted transaction did not match disk: ${JSON.stringify({ accepted, afterAccept })}`)
}

const undone = await evaluate(`return await window.omnicode.diff.undo(${JSON.stringify(proposal.id)})`)
const afterUndo = {
  keep: await fs.readFile(`${root}/${names.keep}`, 'utf8'),
  remove: await fs.readFile(`${root}/${names.remove}`, 'utf8'),
  createdExists: await fs.access(`${root}/${names.created}`).then(() => true, () => false)
}
if (undone.status !== 'pending' || afterUndo.keep !== 'before\n' || afterUndo.remove !== 'restore me\n' || afterUndo.createdExists) {
  throw new Error(`Undo did not restore the snapshot: ${JSON.stringify({ undone, afterUndo })}`)
}

const boundaries = await evaluate(`
  const root = ${JSON.stringify(root)}
  const names = ${JSON.stringify(names)}
  const rejectedProposal = await window.omnicode.diff.propose({
    workspaceRoot: root,
    changes: [{ kind: 'modify', path: names.keep, content: 'must not reach disk\\n' }]
  })
  const rejected = await window.omnicode.diff.reject(rejectedProposal.id, { scope: 'all' })
  let traversalError = ''
  try {
    await window.omnicode.diff.propose({ workspaceRoot: root, changes: [{ kind: 'create', path: '../escaped.txt', content: 'blocked' }] })
  } catch (error) { traversalError = String(error) }
  let commandError = ''
  try {
    await window.omnicode.agent.approveCommand(root, 'echo safe && sudo whoami', 'Unsafe audit command')
  } catch (error) { commandError = String(error) }
  let outsideRootError = ''
  try {
    await window.omnicode.agent.approveCommand('/tmp', 'npm test', 'Wrong workspace')
  } catch (error) { outsideRootError = String(error) }
  return { rejected: rejected.status, traversalError, commandError, outsideRootError }
`)
if (await fs.readFile(`${root}/${names.keep}`, 'utf8') !== 'before\n' || boundaries.rejected !== 'rejected') {
  throw new Error(`Rejected diff changed disk: ${JSON.stringify(boundaries)}`)
}
if (!/outside/iu.test(boundaries.traversalError) || !/Command blocked/iu.test(boundaries.commandError) || !/currently open folder/iu.test(boundaries.outsideRootError)) {
  throw new Error(`Backend boundaries failed: ${JSON.stringify(boundaries)}`)
}

await evaluate(`
  await window.omnicode.workspace.trashEntry(${JSON.stringify(`${root}/${names.keep}`)})
  await window.omnicode.workspace.trashEntry(${JSON.stringify(`${root}/${names.remove}`)})
  return true
`)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  proposal: { files: proposal.files.map((file) => ({ path: file.relativePath, kind: file.kind })), status: proposal.status },
  accepted: accepted.status,
  undone: undone.status,
  boundaries,
  cleanup: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
