import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const appBinary = await fs.realpath(process.argv[2] ?? '')
const profile = await fs.realpath(process.argv[3] ?? '')
const workspace = await fs.realpath(process.argv[4] ?? '')
const runs = Number(process.argv[5] ?? 3)
const appContents = `${appBinary.slice(0, appBinary.indexOf('/Contents/') + '/Contents/'.length)}`

if (!appBinary.includes('.app/Contents/MacOS/') || !Number.isInteger(runs) || runs < 2 || runs > 5) {
  throw new Error('Usage: node scripts/audit-startup-soak.mjs <app-binary> <profile> <workspace> [runs=3]')
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function cpuSeconds(value) {
  const [dayPart, clockPart] = value.includes('-') ? value.split('-') : ['0', value]
  const units = clockPart.split(':').map(Number)
  const seconds = units.pop() ?? 0
  const minutes = units.pop() ?? 0
  const hours = units.pop() ?? 0
  return Number(dayPart) * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

async function processSample() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,command='])
  const processes = stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/u)
    if (!match || !match[5].startsWith(appContents)) return []
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      cpuTimeSeconds: cpuSeconds(match[4])
    }]
  })
  return {
    sampledAt: Date.now(),
    count: processes.length,
    rssMiB: Math.round(processes.reduce((sum, item) => sum + item.rssKiB, 0) / 1024),
    cpuTimeSeconds: processes.reduce((sum, item) => sum + item.cpuTimeSeconds, 0),
    processes: processes.map(({ pid, ppid, rssKiB }) => ({ pid, ppid, rssMiB: Math.round(rssKiB / 1024) }))
  }
}

async function connect(port) {
  let target
  await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
    target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    return Boolean(target)
  }, `debug target on port ${port}`)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const errors = []
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
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'Runtime exception')
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') errors.push(message.params.entry.text)
  })
  const call = (method, params = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const evaluate = async (body) => {
    const response = await call('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  await call('Runtime.enable')
  await call('Log.enable')
  return { socket, evaluate, errors }
}

const results = []
for (let run = 0; run < runs; run += 1) {
  const port = 9_410 + run
  const stderr = []
  const startedAt = Date.now()
  const child = spawn(appBinary, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    workspace
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (stderr.join('').length < 100_000) stderr.push(String(chunk))
  })

  const cdp = await connect(port)
  await waitFor(async () => cdp.evaluate(`return Boolean(window.omnicode && document.querySelector('.app-shell'))`), 'workbench shell')
  const shellReadyMs = Date.now() - startedAt
  await waitFor(async () => cdp.evaluate(`return document.querySelector('.command-center span')?.textContent === ${JSON.stringify(path.basename(workspace))}`), 'launch workspace')
  const workspaceReadyMs = Date.now() - startedAt
  const renderer = await cdp.evaluate(`return { title: document.title, url: location.href, bodyText: document.body.innerText.slice(0, 500) }`)
  if (renderer.title !== 'OmniCode' || !renderer.url.startsWith('file:') || !renderer.bodyText.includes('EXPLORER')) {
    throw new Error(`Run ${run + 1} rendered an unexpected workbench: ${JSON.stringify(renderer)}`)
  }

  // Monaco workers and Chromium's GPU process continue warming briefly after
  // the shell first paints. Measure sustained idle after that startup window.
  await new Promise((resolve) => setTimeout(resolve, 20_000))
  const idleStart = await processSample()
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const idleEnd = await processSample()
  const elapsedSeconds = (idleEnd.sampledAt - idleStart.sampledAt) / 1_000
  const idleCpu = Math.max(0, (idleEnd.cpuTimeSeconds - idleStart.cpuTimeSeconds) / elapsedSeconds * 100)

  const unexpectedRendererErrors = cdp.errors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedRendererErrors.length) throw new Error(`Run ${run + 1} renderer errors: ${unexpectedRendererErrors.join(' | ')}`)
  if (shellReadyMs > 20_000 || workspaceReadyMs > 25_000) throw new Error(`Run ${run + 1} startup was too slow: ${JSON.stringify({ shellReadyMs, workspaceReadyMs })}`)
  if (idleEnd.rssMiB > 1_000 || idleCpu > 10) throw new Error(`Run ${run + 1} idle resources exceeded bounds: ${JSON.stringify({ idleCpu, idleEnd })}`)

  cdp.socket.close()
  const quitStartedAt = Date.now()
  await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "OmniCode" to quit'])
  await waitFor(() => {
    try { process.kill(child.pid, 0); return false } catch { return true }
  }, `run ${run + 1} process exit`, 15_000)
  await waitFor(async () => (await processSample()).count === 0, `run ${run + 1} child-process cleanup`, 15_000)
  const quitMs = Date.now() - quitStartedAt
  const seriousStderr = stderr.join('').split('\n').filter((line) => /UnhandledPromiseRejection|FATAL|uncaught exception|segmentation fault/iu.test(line))
  if (seriousStderr.length) throw new Error(`Run ${run + 1} stderr failure: ${seriousStderr.join(' | ')}`)
  results.push({ run: run + 1, shellReadyMs, workspaceReadyMs, quitMs, idleCpu, rssMiB: idleEnd.rssMiB, processes: idleEnd.count, rendererErrors: unexpectedRendererErrors.length, seriousStderr: seriousStderr.length })
}

console.log(JSON.stringify({ runs: results }, null, 2))
