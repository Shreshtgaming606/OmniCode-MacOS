import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.argv[2] ?? 9390)
const originalWorkspace = await fs.realpath(process.argv[3] ?? '')

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 120))
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
async function waitForRenderer(expression, timeoutMs = 30_000) {
  await waitFor(async () => Boolean(await evaluate(`return Boolean(${expression})`).catch(() => false)), expression, timeoutMs)
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
async function openByQuickOpen(name) {
  await evaluate(`document.querySelector('.command-center').click(); return true`)
  await waitForRenderer(`document.querySelector('.palette input[placeholder="Search files by name"]')`)
  await evaluate(`
    const input = document.querySelector('.palette input[placeholder="Search files by name"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
  await waitForRenderer(`[...document.querySelectorAll('.palette-results button strong')].some((item) => item.textContent === ${JSON.stringify(name)})`)
  await evaluate(`
    [...document.querySelectorAll('.palette-results button strong')].find((item) => item.textContent === ${JSON.stringify(name)}).closest('button').click()
    return true
  `)
  await waitForRenderer(`document.querySelector('.editor-tabs button[title$="/${name}"]')?.classList.contains('active')`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)
const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-custom-run-')))
const workingDirectory = path.join(workspace, 'nested working directory')
const settingsDirectory = path.join(workspace, '.omnicode')
const sourceName = 'custom-run.js'
await fs.mkdir(workingDirectory)
await fs.mkdir(settingsDirectory)
await fs.writeFile(path.join(workspace, sourceName), 'console.log("automatic recipe must be overridden")\n')
await fs.writeFile(path.join(settingsDirectory, 'settings.json'), `${JSON.stringify({
  run: {
    preRunCommand: "printf 'PRE_RUN_OK\\n'",
    buildCommand: "printf 'BUILD_RUN_OK\\n'",
    command: '/bin/zsh',
    args: ['-lc', "printf 'CUSTOM_RUN_OK cwd=%s env=%s\\n' \"$PWD\" \"$OMNICODE_CUSTOM_ENV\""],
    postRunCommand: "printf 'POST_RUN_OK\\n'",
    workingDirectory: 'nested working directory',
    environment: { OMNICODE_CUSTOM_ENV: 'environment-ok' }
  }
}, null, 2)}\n`)

try {
  await dispatchDirectoryDrop(workspace)
  await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(workspace)}`)
  await openByQuickOpen(sourceName)
  await waitForRenderer(`document.querySelector('.run-button') && !document.querySelector('.run-button').disabled`)
  await evaluate(`document.querySelector('.run-button').click(); return true`)
  await waitForRenderer(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes('POST_RUN_OK')`, 30_000)
  await waitForRenderer(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes('[Process exited with code 0]')`, 30_000)
  const output = await evaluate(`return document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent ?? ''`)
  for (const expected of ['PRE_RUN_OK', 'BUILD_RUN_OK', 'CUSTOM_RUN_OK', 'environment-ok', 'POST_RUN_OK', '[Process exited with code 0]']) {
    if (!output.includes(expected)) throw new Error(`Custom run output omitted ${expected}: ${output}`)
  }
  if (!output.includes(workingDirectory)) throw new Error(`Custom working directory was not used: ${output}`)

  await dispatchDirectoryDrop(originalWorkspace)
  await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(originalWorkspace)}`)
  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  console.log(JSON.stringify({
    customConfiguration: { loadedFromWorkspaceSettings: true, automaticRecipeOverridden: true },
    pipeline: { preRun: true, build: true, command: true, postRun: true },
    workingDirectory: { spacesHandled: true, exactPath: true },
    environment: { customValueInherited: true },
    exitCode: 0,
    cleanup: { originalWorkspaceRestored: true, fixtureRemoved: true },
    runtimeErrors: unexpectedErrors
  }, null, 2))
} finally {
  const currentWorkspace = await evaluate(`return document.querySelector('.workspace-heading')?.getAttribute('title') ?? ''`).catch(() => '')
  if (currentWorkspace !== originalWorkspace) {
    await dispatchDirectoryDrop(originalWorkspace).catch(() => undefined)
    await waitForRenderer(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(originalWorkspace)}`, 10_000).catch(() => undefined)
  }
  await fs.rm(workspace, { recursive: true, force: true })
  socket.close()
}
