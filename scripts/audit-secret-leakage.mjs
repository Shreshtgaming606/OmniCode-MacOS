import { promises as fs } from 'node:fs'
import path from 'node:path'

const port = Number(process.argv[2] ?? 9390)
const repository = await fs.realpath(process.argv[3] ?? '.')
const profile = await fs.realpath(process.argv[4] ?? '')
const workspace = await fs.realpath(process.argv[5] ?? '')
const tokenPattern = /(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/gu
const allowedFixture = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz123456'

async function filesUnder(root, ignoredNames = new Set()) {
  const files = []
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (ignoredNames.has(entry.name)) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (entry.isFile()) files.push(target)
    }
  }
  await walk(root)
  return files
}

async function scan(root, ignoredNames, allowKnownFixture = false) {
  const findings = []
  let scannedFiles = 0
  for (const file of await filesUnder(root, ignoredNames)) {
    const stats = await fs.stat(file)
    if (stats.size > 32 * 1024 * 1024) continue
    const contents = (await fs.readFile(file)).toString('latin1')
    const matches = [...contents.matchAll(tokenPattern)].map((match) => match[0])
    const unexpected = matches.filter((value) => !(allowKnownFixture && path.relative(root, file) === 'src/main/services/git-manager.test.ts' && value === allowedFixture))
    scannedFiles += 1
    if (unexpected.length) findings.push({ path: path.relative(root, file), count: unexpected.length })
  }
  return { scannedFiles, findings }
}

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
let nextId = 1
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data))
  if (!message.id) return
  const operation = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) operation?.reject(new Error(message.error.message))
  else operation?.resolve(message.result)
})
function call(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

const repositoryScan = await scan(repository, new Set(['.git', 'node_modules', 'dist', 'out', 'coverage']), true)
const profileScan = await scan(profile, new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache']))
const workspaceScan = await scan(workspace, new Set(['.git', 'node_modules', 'dist', 'build']))
const renderer = await evaluate(`(() => {
  const pattern = /(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/u
  const storageValues = Object.values(localStorage)
  const renderedDiagnostics = [...document.querySelectorAll('.output-view, .toast, .inline-error, .terminal-panel__viewport')].map((node) => node.textContent ?? '')
  return {
    localStorageValues: storageValues.length,
    localStorageMatches: storageValues.filter((value) => pattern.test(value)).length,
    renderedDiagnosticMatches: renderedDiagnostics.filter((value) => pattern.test(value)).length
  }
})()`)
const keychainPresence = await evaluate(`Promise.all(['openai', 'anthropic', 'google'].map(async (provider) => [provider, await window.omnicode.ai.hasCredential(provider)])).then(Object.fromEntries)`)
socket.close()

const findings = [...repositoryScan.findings, ...profileScan.findings, ...workspaceScan.findings]
if (findings.length || renderer.localStorageMatches || renderer.renderedDiagnosticMatches) {
  throw new Error(`Potential credential material found outside Keychain: ${JSON.stringify({ findings, renderer })}`)
}

console.log(JSON.stringify({
  repository: { scannedFiles: repositoryScan.scannedFiles, unexpectedCredentialMatches: 0, knownSyntheticRedactionFixtures: 1 },
  isolatedProfile: { scannedFiles: profileScan.scannedFiles, credentialMatches: 0 },
  workspace: { scannedFiles: workspaceScan.scannedFiles, credentialMatches: 0 },
  renderer: { localStorageValues: renderer.localStorageValues, localStorageCredentialMatches: 0, renderedDiagnosticCredentialMatches: 0 },
  keychainPresence,
  credentialValuesReadOrPrinted: false
}, null, 2))
