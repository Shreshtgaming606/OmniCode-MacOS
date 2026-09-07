import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const originalWorkspace = await fs.realpath(process.argv[3] ?? '')
const appPathMarker = process.argv[4] ?? '/OmniCode.app/Contents/'

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function processSample() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,command='])
  const cpuTimeSeconds = (value) => {
    const [dayPart, clockPart] = value.includes('-') ? value.split('-') : ['0', value]
    const units = clockPart.split(':').map(Number)
    const seconds = units.pop() ?? 0
    const minutes = units.pop() ?? 0
    const hours = units.pop() ?? 0
    return Number(dayPart) * 86_400 + hours * 3_600 + minutes * 60 + seconds
  }
  const processes = stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/u)
    if (!match || Number(match[1]) === process.pid || !match[5].includes(appPathMarker)) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), cpuTimeSeconds: cpuTimeSeconds(match[4]), command: match[5] }]
  })
  return {
    count: processes.length,
    sampledAt: Date.now(),
    cpuTimeSeconds: processes.reduce((total, item) => total + item.cpuTimeSeconds, 0),
    rssMiB: Math.round(processes.reduce((total, item) => total + item.rssKiB, 0) / 1024),
    processes: processes.map(({ pid, ppid, rssKiB }) => ({ pid, ppid, rssMiB: Math.round(rssKiB / 1024) }))
  }
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

await call('Runtime.enable')
await call('Log.enable')
await waitForRenderer(`window.omnicode && document.querySelector('.app-shell')`)
const before = await processSample()

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-performance-'))
const source = path.join(root, 'src')
await fs.mkdir(source)
for (let directory = 0; directory < 20; directory += 1) {
  const nested = path.join(source, `module-${directory}`)
  await fs.mkdir(nested)
  const writes = []
  for (let file = 0; file < 60; file += 1) {
    const marker = directory === 17 && file === 42 ? ' OMNICODE_LARGE_WORKSPACE_TARGET' : ''
    writes.push(fs.writeFile(path.join(nested, `file-${file}.ts`), `export const value_${directory}_${file} = '${directory}:${file}${marker}'\n`))
  }
  await Promise.all(writes)
}
await fs.writeFile(path.join(root, '.gitignore'), 'ignored-git/\n')
await fs.writeFile(path.join(root, '.omnicodeignore'), 'ignored-omni/\n')
await fs.mkdir(path.join(root, 'ignored-git'))
await fs.mkdir(path.join(root, 'ignored-omni'))
await fs.mkdir(path.join(root, 'node_modules'))
await fs.writeFile(path.join(root, 'ignored-git', 'hidden.ts'), 'OMNICODE_LARGE_WORKSPACE_TARGET\n')
await fs.writeFile(path.join(root, 'ignored-omni', 'hidden.ts'), 'OMNICODE_LARGE_WORKSPACE_TARGET\n')
await fs.writeFile(path.join(root, 'node_modules', 'hidden.ts'), 'OMNICODE_LARGE_WORKSPACE_TARGET\n')
await fs.writeFile(path.join(root, 'excluded-target.ts'), 'OMNICODE_LARGE_WORKSPACE_TARGET\n')
await fs.writeFile(path.join(root, 'binary.dat'), Buffer.alloc(256 * 1024, 0))
const canonicalRoot = await fs.realpath(root)

const openStarted = Date.now()
await dispatchDirectoryDrop(canonicalRoot)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(canonicalRoot))}`, 30_000)
const workspaceOpenMs = Date.now() - openStarted

const indexing = await evaluate(`
  let ticks = 0
  const timer = window.setInterval(() => { ticks += 1 }, 25)
  const started = performance.now()
  const result = await window.omnicode.ai.index(${JSON.stringify(canonicalRoot)})
  const durationMs = performance.now() - started
  window.clearInterval(timer)
  return { ...result, durationMs, rendererTicks: ticks }
`)
const search = await evaluate(`
  let ticks = 0
  const timer = window.setInterval(() => { ticks += 1 }, 25)
  const started = performance.now()
  const matches = await window.omnicode.workspace.search(
    ${JSON.stringify(canonicalRoot)},
    'OMNICODE_LARGE_WORKSPACE_TARGET',
    { include: '**/*.ts', exclude: '**/excluded-*' }
  )
  const durationMs = performance.now() - started
  window.clearInterval(timer)
  return { matches, durationMs, rendererTicks: ticks }
`)
if (search.matches.length !== 1 || !search.matches[0].path.endsWith('/module-17/file-42.ts')) {
  throw new Error(`Large-workspace ignore/include/exclude search was inaccurate: ${JSON.stringify(search)}`)
}
if (indexing.fileCount < 1_200 || indexing.fileCount > 1_205) throw new Error(`Large-workspace index count was inaccurate: ${JSON.stringify(indexing)}`)
if (workspaceOpenMs > 15_000 || indexing.durationMs > 15_000 || search.durationMs > 10_000) {
  throw new Error(`Large-workspace operation exceeded its responsiveness bound: ${JSON.stringify({ workspaceOpenMs, indexing, search })}`)
}
if (indexing.durationMs > 100 && indexing.rendererTicks < 2) throw new Error('The renderer stopped ticking during indexing.')
if (search.durationMs > 100 && search.rendererTicks < 2) throw new Error('The renderer stopped ticking during search.')

const soak = await evaluate(`
  const terminals = []
  for (let index = 0; index < 8; index += 1) {
    const terminal = await window.omnicode.terminal.create({ cwd: ${JSON.stringify(canonicalRoot)}, name: 'Soak ' + index })
    terminals.push(terminal.id)
    window.omnicode.terminal.write(terminal.id, "printf 'PTY_SOAK_OK\\n'\\r")
  }
  for (const id of terminals) await window.omnicode.terminal.kill(id)
  const serverPorts = []
  for (let index = 0; index < 3; index += 1) {
    const state = await window.omnicode.server.start(${JSON.stringify(canonicalRoot)})
    serverPorts.push(state.port)
    await window.omnicode.server.stop()
  }
  return { terminalSessionsCreatedAndKilled: terminals.length, serverPorts }
`)
if (new Set(soak.serverPorts).size < 1 || soak.terminalSessionsCreatedAndKilled !== 8) throw new Error(`Cleanup soak was incomplete: ${JSON.stringify(soak)}`)
const stoppedState = await evaluate(`return await window.omnicode.server.state()`)
if (stoppedState.running) throw new Error('Development server remained running after cleanup soak.')

await dispatchDirectoryDrop(originalWorkspace)
await waitForRenderer(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(originalWorkspace))}`)
await new Promise((resolve) => setTimeout(resolve, 4_000))
const idleSamples = []
let previousIdleSample = await processSample()
for (let index = 0; index < 5; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const sample = await processSample()
  const elapsedSeconds = (sample.sampledAt - previousIdleSample.sampledAt) / 1_000
  const cpu = Math.max(0, (sample.cpuTimeSeconds - previousIdleSample.cpuTimeSeconds) / elapsedSeconds * 100)
  idleSamples.push({ ...sample, cpu })
  previousIdleSample = sample
}
const after = idleSamples.at(-1)
const sortedCpu = idleSamples.map((sample) => sample.cpu).sort((left, right) => left - right)
const medianIdleCpu = sortedCpu[Math.floor(sortedCpu.length / 2)]
if (medianIdleCpu > 5) throw new Error(`Idle CPU remained high after the soak: ${JSON.stringify(idleSamples)}`)
if (after.rssMiB > 1_500 || after.rssMiB - before.rssMiB > 600) {
  throw new Error(`Memory remained excessive after restoring the small workspace: ${JSON.stringify({ before, after })}`)
}

const trashDestination = path.join(os.homedir(), '.Trash', path.basename(canonicalRoot))
await fs.rename(canonicalRoot, trashDestination)
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  fixture: { sourceFiles: 1_200, ignoredFiles: 3, binaryBytes: 256 * 1024 },
  workspaceOpenMs,
  indexing,
  search: { matches: search.matches, durationMs: search.durationMs, rendererTicks: search.rendererTicks },
  soak,
  resources: { before, after, medianIdleCpu, samples: idleSamples.map(({ cpu, rssMiB, count }) => ({ cpu, rssMiB, count })) },
  cleanup: { recoverableTrashPath: trashDestination },
  runtimeErrors: unexpectedErrors
}, null, 2))
