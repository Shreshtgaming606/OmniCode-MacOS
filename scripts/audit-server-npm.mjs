import { promises as fs } from 'node:fs'
import http from 'node:http'

const port = Number(process.argv[2] ?? 9350)
let workspace = process.argv[3]
if (!workspace) throw new Error('Usage: node scripts/audit-server-npm.mjs <debug-port> <workspace>')
workspace = await fs.realpath(workspace)

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

async function listen(server, requestedPort = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not determine the audit server port.')
  return address.port
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function assertPortReleased(releasedPort) {
  const probe = http.createServer()
  await listen(probe, releasedPort)
  await close(probe)
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

const existing = await fs.readdir(workspace)
for (const reserved of ['package.json', 'server.mjs', 'OmniCode Server Audit']) {
  if (existing.includes(reserved)) throw new Error(`The disposable audit workspace already contains ${reserved}.`)
}

const occupied = http.createServer((_request, response) => response.end('occupied'))
const occupiedPort = await listen(occupied)
const rootLiteral = JSON.stringify(workspace)

const staticResult = await evaluate(`
  const workspace = ${rootLiteral}
  const auditRoot = await window.omnicode.workspace.createEntry(workspace, 'OmniCode Server Audit', 'directory')
  const assets = await window.omnicode.workspace.createEntry(auditRoot, 'assets', 'directory')
  const nested = await window.omnicode.workspace.createEntry(auditRoot, 'nested', 'directory')
  const index = await window.omnicode.workspace.createEntry(auditRoot, 'index.html', 'file')
  const css = await window.omnicode.workspace.createEntry(assets, 'site.css', 'file')
  const js = await window.omnicode.workspace.createEntry(assets, 'site.js', 'file')
  const nestedFile = await window.omnicode.workspace.createEntry(nested, 'message.txt', 'file')
  await window.omnicode.workspace.writeFile(index, '<!doctype html><link rel="stylesheet" href="assets/site.css"><script src="assets/site.js"></script><main>STATIC_OK</main></body>')
  await window.omnicode.workspace.writeFile(css, 'main { color: blue; }')
  await window.omnicode.workspace.writeFile(js, 'globalThis.OMNICODE_STATIC_OK = true')
  await window.omnicode.workspace.writeFile(nestedFile, 'NESTED_OK')

  let conflictError = ''
  try { await window.omnicode.server.start(workspace, ${occupiedPort}) }
  catch (error) { conflictError = String(error) }
  const conflictState = await window.omnicode.server.state()
  const state = await window.omnicode.server.start(workspace)
  const base = state.url + '/OmniCode%20Server%20Audit'
  const html = await fetch(base + '/index.html').then((response) => response.text())
  const cssText = await fetch(base + '/assets/site.css').then((response) => response.text())
  const jsText = await fetch(base + '/assets/site.js').then((response) => response.text())
  const nestedText = await fetch(base + '/nested/message.txt').then((response) => response.text())

  const controller = new AbortController()
  const events = await fetch(state.url + '/__omnicode_events', { signal: controller.signal })
  const reader = events.body.getReader()
  await reader.read()
  await window.omnicode.workspace.writeFile(css, 'main { color: green; }')
  let reloadText = ''
  const deadline = Date.now() + 10000
  while (!reloadText.includes('event: reload') && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: false, value: new Uint8Array() }), 500))
    ])
    reloadText += new TextDecoder().decode(chunk.value)
  }
  controller.abort()
  const usedPort = state.port
  await window.omnicode.server.stop()
  const restarted = await window.omnicode.server.start(workspace, usedPort)
  const restartText = await fetch(restarted.url + '/OmniCode%20Server%20Audit/index.html').then((response) => response.text())
  await window.omnicode.server.stop()
  return { auditRoot, conflictError, conflictState, state, html, cssText, jsText, nestedText, reloadText, restarted, restartText }
`)

await close(occupied)
if (!/already in use|port/iu.test(staticResult.conflictError) || staticResult.conflictState.running) {
  throw new Error(`Static port conflict was not reported correctly: ${JSON.stringify(staticResult)}`)
}
if (staticResult.state.port === occupiedPort || !staticResult.html.includes('STATIC_OK') ||
    !staticResult.html.includes("new EventSource('/__omnicode_events')") ||
    !staticResult.cssText.includes('color: blue') || !staticResult.jsText.includes('OMNICODE_STATIC_OK') ||
    staticResult.nestedText !== 'NESTED_OK' || !staticResult.reloadText.includes('event: reload') ||
    !staticResult.restartText.includes('STATIC_OK')) {
  throw new Error(`Static server integration failed: ${JSON.stringify(staticResult)}`)
}
await assertPortReleased(staticResult.state.port)

const packageResult = await evaluate(`
  const workspace = ${rootLiteral}
  const manifest = await window.omnicode.workspace.createEntry(workspace, 'package.json', 'file')
  const source = await window.omnicode.workspace.createEntry(workspace, 'server.mjs', 'file')
  await window.omnicode.workspace.writeFile(manifest, JSON.stringify({ scripts: { dev: 'node -e "process.exit(7)"' } }, null, 2))
  let failure = ''
  try { await window.omnicode.server.startProject(workspace, 'dev') }
  catch (error) { failure = String(error) }
  const failureState = await window.omnicode.server.state()

  await window.omnicode.workspace.writeFile(source, \`
    import http from 'node:http'
    const port = Number(process.env.PORT || 0)
    const server = http.createServer((_request, response) => response.end('NPM_SERVER_OK'))
    server.listen(port, '127.0.0.1', () => console.log('Ready at http://localhost:' + server.address().port))
    process.on('SIGTERM', () => server.close(() => process.exit(0)))
  \`)
  await window.omnicode.workspace.writeFile(manifest, JSON.stringify({ scripts: { dev: 'node server.mjs', verify: 'node -e "console.log(123)"' } }, null, 2))
  const options = await window.omnicode.server.detect(workspace)
  const scripts = await window.omnicode.run.packageScripts(workspace)
  const logs = []
  const unsubscribe = window.omnicode.server.onLog((line) => logs.push(line))
  const state = await window.omnicode.server.startProject(workspace, 'dev')
  const response = await fetch(state.url).then((item) => item.text())
  const usedPort = state.port
  await window.omnicode.server.stop()
  const restarted = await window.omnicode.server.startProject(workspace, 'dev', usedPort)
  const restartResponse = await fetch(restarted.url).then((item) => item.text())
  await window.omnicode.server.stop()
  unsubscribe()
  return { manifest, source, failure, failureState, options, scripts, state, response, restarted, restartResponse, logs }
`)

if (!/exited.*7/iu.test(packageResult.failure) || packageResult.failureState.running ||
    !packageResult.options.some((option) => option.kind === 'package' && option.script === 'dev' && option.packageManager === 'npm') ||
    !packageResult.scripts.some((script) => script.name === 'dev' && script.command === "npm run 'dev'") ||
    packageResult.response !== 'NPM_SERVER_OK' || packageResult.restartResponse !== 'NPM_SERVER_OK' ||
    !packageResult.state.url || !packageResult.logs.some((line) => /Ready at http:\/\/localhost:/u.test(line))) {
  throw new Error(`Package server integration failed: ${JSON.stringify(packageResult)}`)
}
await assertPortReleased(packageResult.state.port)
if (await fs.stat(`${workspace}/node_modules`).then(() => true, () => false)) {
  throw new Error('The npm server workflow installed dependencies without approval.')
}

await evaluate(`
  document.querySelector('.activity-button[aria-label="Run & Build"]').click()
  return true
`)
await waitFor(`document.querySelector('.run-view') && [...document.querySelectorAll('.server-list button')].some((button) => button.textContent.includes('Static server'))`)
await evaluate(`
  const button = [...document.querySelectorAll('.server-list button')].find((item) => item.textContent.includes('Static server'))
  button.click()
  return true
`)
await waitFor(`document.querySelector('.running-server')?.textContent.includes('Static server')`)
const uiStatic = await evaluate(`return document.querySelector('.running-server')?.textContent || ''`)
await evaluate(`document.querySelector('button[title="Stop server"]').click(); return true`)
await waitFor(`!document.querySelector('.running-server')`)
await evaluate(`
  const button = [...document.querySelectorAll('.server-list button')].find((item) => item.textContent.includes('npm run dev'))
  button.click()
  return true
`)
await waitFor(`document.querySelector('.running-server')?.textContent.includes('npm run dev')`, 40_000)
const uiPackage = await evaluate(`return document.querySelector('.running-server')?.textContent || ''`)
await evaluate(`document.querySelector('button[title="Stop server"]').click(); return true`)
await waitFor(`!document.querySelector('.running-server')`)
await evaluate(`
  const button = [...document.querySelectorAll('.script-list:not(.server-list) button')]
    .find((item) => item.querySelector('strong')?.textContent === 'verify')
  button.click()
  return true
`)
await waitFor(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes('123')`, 30_000)
await waitFor(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes('[Process exited with code 0]')`, 30_000)
const uiScript = await evaluate(`return document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent || ''`)

await evaluate(`
  await window.omnicode.server.stop()
  await window.omnicode.workspace.trashEntry(${JSON.stringify(packageResult.manifest)})
  await window.omnicode.workspace.trashEntry(${JSON.stringify(packageResult.source)})
  await window.omnicode.workspace.trashEntry(${JSON.stringify(staticResult.auditRoot)})
  return true
`)

for (const targetPath of [packageResult.manifest, packageResult.source, staticResult.auditRoot]) {
  if (await fs.stat(targetPath).then(() => true, () => false)) throw new Error(`Audit fixture was not removed: ${targetPath}`)
}
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()

console.log(JSON.stringify({
  staticServer: {
    assets: true,
    nestedPaths: true,
    liveReload: true,
    portConflict: true,
    restart: true,
    portReleased: true
  },
  npmProject: {
    scriptDetection: true,
    prematureExitRejected: true,
    reachableBeforeSuccess: true,
    logs: true,
    restart: true,
    processStopped: true,
    noAutomaticInstall: true
  },
  packagedUi: { static: uiStatic, package: uiPackage, packageScript: uiScript.includes('123') && uiScript.includes('[Process exited with code 0]') },
  runtimeErrors: unexpectedErrors
}, null, 2))
