import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'

const appBinary = process.argv[2]
if (!appBinary?.endsWith('/OmniCode.app/Contents/MacOS/OmniCode')) throw new Error('Pass the packaged OmniCode executable.')
await fs.access(appBinary)
const profile = await fs.mkdtemp(path.join(tmpdir(), 'omnicode-spotlight-audit-'))
const workspace = path.join(profile, 'OmniCode Spotlight Test Project')
await fs.mkdir(workspace)
await fs.writeFile(path.join(profile, 'recent-workspaces.json'), JSON.stringify([workspace]), { mode: 0o600 })
const listener = net.createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const child = spawn(appBinary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' })
let socket
let passed = false

async function pageTarget() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
    const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && !item.url?.includes('omni-overlay'))
    if (page) return page
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('Packaged OmniCode renderer did not launch.')
}

try {
  const page = await pageTarget()
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if (!message.id) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry?.reject(new Error(message.error.message))
    else entry?.resolve(message.result)
  })
  const evaluate = async (body) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
    } }))
    const response = await new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  const waitFor = async (probe, message, timeout = 30_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await evaluate(probe).catch(() => null)
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    const state = await evaluate("return { mode: localStorage.getItem('omnicode.appMode'), title: document.querySelector('.command-center span')?.textContent, work: document.querySelector('.work-chat-heading strong')?.textContent, alert: document.querySelector('[role=alert]')?.textContent?.slice(0, 160) }").catch(() => null)
    throw new Error(`${message} Observed: ${JSON.stringify(state)}`)
  }
  await waitFor('return Boolean(window.omnicode?.spotlight)', 'Spotlight bridge did not load.')
  const settings = await evaluate('return await window.omnicode.spotlight.settings()')
  if (!settings.available) throw new Error('Core Spotlight reports indexing unavailable.')
  const conversation = await evaluate("return await window.omnicode.work.conversations.create({ title: 'OmniCode Spotlight Test Conversation', provider: 'ollama', modelId: '' })")
  await evaluate('return await window.omnicode.spotlight.rebuild()')
  let results
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) {
    results = await evaluate("return await window.omnicode.spotlight.search('OmniCode Spotlight Test')").catch(() => [])
    if (results.some((item) => item.kind === 'workspace') && results.some((item) => item.id === `conversation:work:${conversation.id}`)) break
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  const workspaceItem = results?.find((item) => item.kind === 'workspace')
  if (!workspaceItem || !results.some((item) => item.id === `conversation:work:${conversation.id}`)) throw new Error('Real Core Spotlight query did not return both test metadata records.')
  console.log('PASS — real Core Spotlight query returned the workspace and Work conversation metadata.')
  const semantic = await evaluate("return await window.omnicode.spotlight.search('coding test project')")
  console.log(`Semantic-query observation: ${semantic.some((item) => item.id === workspaceItem.id) ? 'related workspace returned' : 'no related workspace returned'}; no semantic match is assumed.`)
  if (process.argv.includes('--gui-hold')) {
    console.log(`GUI-HOLD pid=${process.pid} workspace=${workspaceItem.id} conversation=conversation:work:${conversation.id}`)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 180_000)
      process.once('SIGUSR1', () => { clearTimeout(timer); resolve() })
    })
  }
  await evaluate(`return await window.omnicode.spotlight.openResult(${JSON.stringify(workspaceItem.id)})`)
  await waitFor("return document.querySelector('.code-mode-host')?.getAttribute('aria-hidden') === 'false' && document.querySelector('.command-center span')?.textContent === 'OmniCode Spotlight Test Project'", 'Spotlight workspace result did not open the exact Code workspace.')
  console.log('PASS — selected workspace result opened Code Mode and the exact test workspace.')
  await evaluate(`return await window.omnicode.spotlight.openResult(${JSON.stringify(`conversation:work:${conversation.id}`)})`)
  await waitFor("return localStorage.getItem('omnicode.appMode') === 'work' && document.querySelector('.work-chat-heading strong')?.textContent === 'OmniCode Spotlight Test Conversation'", 'Spotlight conversation result did not open the exact Work conversation.')
  console.log('PASS — selected conversation result opened the exact Work conversation.')
  await evaluate('return await window.omnicode.spotlight.clear()')
  const afterClear = await evaluate("return await window.omnicode.spotlight.search('OmniCode Spotlight Test')")
  if (afterClear.some((item) => item.id === workspaceItem.id || item.id === `conversation:work:${conversation.id}`)) throw new Error('Temporary Spotlight results remained after clear.')
  console.log('PASS — temporary Spotlight records were removed from OmniCode’s index.')
  passed = true
} finally {
  socket?.close()
  child.kill('SIGTERM')
  await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) })
  if (passed) await fs.rm(profile, { recursive: true, force: true })
  else console.error(`Preserved failed Spotlight audit profile: ${profile}`)
}
