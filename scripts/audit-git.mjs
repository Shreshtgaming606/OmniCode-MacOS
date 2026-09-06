import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.argv[2] ?? 9350)
let workspace = process.argv[3]
if (!workspace) throw new Error('Usage: node scripts/audit-git.mjs <debug-port> <workspace>')
workspace = await fs.realpath(workspace)

function systemGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.status !== 0) throw new Error(`Independent Git setup failed: git ${args.join(' ')}\n${result.stderr}`)
  return result.stdout
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

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

const initialEntries = await fs.readdir(workspace)
if (initialEntries.length > 0) throw new Error(`Use an empty disposable workspace for the Git audit: ${workspace}`)
const rootLiteral = JSON.stringify(workspace)

await evaluate(`document.querySelector('.activity-button[aria-label="Source Control"]').click(); return true`)
await waitFor(`document.querySelector('.source-view')?.textContent.includes('not a Git repository')`)
await evaluate(`document.querySelector('.source-view .primary-button').click(); return true`)
await waitFor(`document.querySelector('.source-view .branch-controls select')`)
const initialBranch = await evaluate(`return document.querySelector('.source-view .branch-controls select').value`)

const file = await evaluate(`
  const file = await window.omnicode.workspace.createEntry(${rootLiteral}, 'hello file.txt', 'file')
  await window.omnicode.workspace.writeFile(file, 'hello from OmniCode\\n')
  return file
`)
await evaluate(`document.querySelector('.source-view button[title="Refresh"]').click(); return true`)
await waitFor(`document.querySelector('.change-row button[title="Stage"]')`)
await evaluate(`document.querySelector('.change-row .change-file').click(); return true`)
await waitFor(`document.querySelector('.output-view')?.textContent.includes('+hello from OmniCode')`)
const workingDiffVisible = true

await evaluate(`document.querySelector('.change-row button[title="Stage"]').click(); return true`)
await waitFor(`document.querySelector('.git-change-group .section-heading')?.textContent.includes('Staged Changes')`)
await evaluate(`document.querySelector('.change-row button[title="Unstage"]').click(); return true`)
await waitFor(`document.querySelector('.change-row button[title="Stage"]')`)
await evaluate(`document.querySelector('.source-view button[title="Stage all"]').click(); return true`)
await waitFor(`document.querySelector('.change-row button[title="Unstage"]')`)
await evaluate(`
  const input = document.querySelector('.commit-input')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Initial OmniCode audit commit')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
`)
await waitFor(`document.querySelector('.commit-button:not(:disabled)')`)
await evaluate(`document.querySelector('.commit-button').click(); return true`)
await waitFor(`document.querySelector('.git-notice')?.textContent.includes('Commit created') && document.querySelector('.source-clean')`)

await evaluate(`
  window.prompt = () => 'feature/audit'
  document.querySelector('button[title="Create branch"]').click()
  return true
`)
await waitFor(`document.querySelector('.branch-controls select')?.value === 'feature/audit'`)
await evaluate(`
  const select = document.querySelector('.branch-controls select')
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(initialBranch)})
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
`)
await waitFor(`document.querySelector('.branch-controls select')?.value === ${JSON.stringify(initialBranch)}`)
await evaluate(`
  window.prompt = () => 'feature/audit'
  document.querySelector('button[title="Delete another branch"]').click()
  return true
`)
await waitFor(`![...document.querySelectorAll('.branch-controls option')].some((option) => option.value === 'feature/audit')`)

const renameResult = await evaluate(`
  const renamed = await window.omnicode.workspace.renameEntry(${JSON.stringify(file)}, 'renamed file.txt')
  await window.omnicode.git.stage(${rootLiteral}, ['.'])
  const status = await window.omnicode.git.status(${rootLiteral})
  await window.omnicode.git.unstage(${rootLiteral}, ['.'])
  return { renamed, status }
`)
const rename = renameResult.status.changes.find((change) => change.path === 'renamed file.txt')
if (!rename || rename.originalPath !== 'hello file.txt' || rename.indexStatus !== 'R') {
  throw new Error(`Git rename status was incorrect: ${JSON.stringify(renameResult.status)}`)
}
await evaluate(`
  await window.omnicode.git.stage(${rootLiteral}, ['.'])
  await window.omnicode.git.commit(${rootLiteral}, 'Rename audited file')
  return true
`)

const pushFailure = await evaluate(`
  try { await window.omnicode.git.operation(${rootLiteral}, 'push'); return '' }
  catch (error) { return String(error) }
`)
if (!/push destination|remote|upstream/iu.test(pushFailure)) {
  throw new Error(`Git push failure was not useful: ${pushFailure}`)
}

const remoteContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-packaged-git-remote-'))
const remote = path.join(remoteContainer, 'audit.git')
const updater = path.join(remoteContainer, 'updater')
await fs.mkdir(remote)
systemGit(remote, ['init', '--bare'])
const remoteSetupCommand = `git remote add origin ${shellQuote(remote)} && git push --set-upstream origin ${shellQuote(initialBranch)}; code=$?; printf '__OMNI_GIT_REMOTE_DONE__%d\\n' "$code"\r`

const terminalSetup = await evaluate(`
  return await new Promise(async (resolve, reject) => {
    let id = ''
    let output = ''
    const timeout = setTimeout(() => reject(new Error('Timed out adding the Git audit remote.')), 30000)
    const unsubscribe = window.omnicode.terminal.onData((event) => {
      if (event.id !== id) return
      output += event.data
      const exitCode = output.split('__OMNI_GIT_REMOTE_DONE__').at(-1)?.charAt(0)
      if (!exitCode || exitCode < '0' || exitCode > '9') return
      clearTimeout(timeout)
      unsubscribe()
      void window.omnicode.terminal.kill(id).finally(() => resolve(output))
    })
    const session = await window.omnicode.terminal.create({ cwd: ${rootLiteral}, shell: '/bin/zsh', name: 'Git remote setup' })
    id = session.id
    window.omnicode.terminal.write(id, ${JSON.stringify(remoteSetupCommand)})
  })
`)
if (!/__OMNI_GIT_REMOTE_DONE__0/u.test(terminalSetup.replaceAll('\r', ''))) {
  throw new Error(`Could not establish the local Git remote: ${terminalSetup}`)
}

systemGit(remoteContainer, ['clone', remote, updater])
systemGit(updater, ['config', 'user.email', 'tests@omnicode.local'])
systemGit(updater, ['config', 'user.name', 'OmniCode Tests'])
await fs.writeFile(path.join(updater, 'remote.txt'), 'REMOTE_PULL_OK\n')
systemGit(updater, ['add', '--', 'remote.txt'])
systemGit(updater, ['commit', '-m', 'Remote audit change'])
systemGit(updater, ['push'])

await evaluate(`document.querySelector('.source-view button[title="Fetch"]').click(); return true`)
await waitFor(`document.querySelector('.git-notice')?.textContent.includes('Fetched remote updates')`)
const fetched = await evaluate(`return await window.omnicode.git.status(${rootLiteral})`)
if (fetched.behind !== 1) throw new Error(`Fetch did not update behind count: ${JSON.stringify(fetched)}`)
await evaluate(`document.querySelector('.source-view button[title="Pull"]').click(); return true`)
await waitFor(`document.querySelector('.git-notice')?.textContent.includes('Pulled remote changes')`)
if (await fs.readFile(path.join(workspace, 'remote.txt'), 'utf8') !== 'REMOTE_PULL_OK\n') {
  throw new Error('Pull did not update the real workspace file.')
}

await evaluate(`
  const path = ${JSON.stringify(renameResult.renamed)}
  await window.omnicode.workspace.writeFile(path, 'LOCAL_PUSH_OK\\n')
  await window.omnicode.git.stage(${rootLiteral}, ['renamed file.txt'])
  await window.omnicode.git.commit(${rootLiteral}, 'Local audit push')
  return true
`)
await evaluate(`document.querySelector('.source-view button[title="Push"]').click(); return true`)
await waitFor(`document.querySelector('.git-notice')?.textContent.includes('Pushed local commits')`)
const remoteLog = systemGit(remoteContainer, ['--git-dir', remote, 'log', '--format=%s', '-1', initialBranch]).trim()
if (remoteLog !== 'Local audit push') throw new Error(`Push did not reach the bare remote: ${remoteLog}`)

const final = await evaluate(`return await window.omnicode.git.status(${rootLiteral})`)
if (!final.isRepository || final.changes.length || final.ahead || final.behind) {
  throw new Error(`Final Git state was not clean and synchronized: ${JSON.stringify(final)}`)
}
if (!workingDiffVisible) throw new Error('Working-tree diff did not reach the Output panel.')

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
await fs.rm(remoteContainer, { recursive: true, force: true })
socket.close()

console.log(JSON.stringify({
  repository: { initializedInUi: true, status: true, workingDiffVisible, stage: true, unstage: true, commit: true },
  branches: { create: true, switch: true, delete: true },
  rename: { path: rename.path, originalPath: rename.originalPath },
  failureReporting: { pushWithoutRemoteRejected: true },
  remote: { fetch: true, behind: fetched.behind, pull: true, push: true, synchronized: true },
  runtimeErrors: unexpectedErrors
}, null, 2))
