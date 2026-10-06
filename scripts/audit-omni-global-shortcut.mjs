import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const port = Number(process.argv[2] ?? 9352)
const helperPath = process.argv[3]
if (!helperPath) throw new Error('Usage: node scripts/audit-omni-global-shortcut.mjs <debug-port> <cursor-helper-path>')

async function targets() {
  return fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
}
async function targetWhenReady(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const target = (await targets()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl && predicate(item))
    if (target) return target
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Timed out waiting for an OmniCode renderer.')
}
async function connection(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let sequence = 0
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
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (body) => {
    const response = await call('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
    })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  await call('Runtime.enable')
  return { socket, evaluate }
}
async function pressShortcut() {
  const id = randomUUID()
  const request = JSON.stringify({ version: 1, id, command: 'press-key', key: 'space', modifiers: ['command', 'shift'], repeat: 1 })
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', () => {
      try {
        const response = JSON.parse(stdout.trim())
        if (response.id !== id || response.ok !== true) throw new Error(response.error?.message ?? 'The native helper rejected the shortcut.')
        resolve(response.result)
      } catch (error) {
        reject(new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? ` (${stderr.length} stderr bytes)` : ''}`))
      }
    })
    child.stdin.end(`${request}\n`)
  })
}

const mainTarget = await targetWhenReady((target) => !target.url?.includes('omni-overlay.html'))
const main = await connection(mainTarget)
const original = await main.evaluate(`return await window.omnicode.omni.settings.get()`)
try {
  await main.evaluate(`return await window.omnicode.omni.settings.update({ enabled: true, setupCompleted: true })`)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const readiness = await main.evaluate(`return await window.omnicode.omni.cursor.status()`)
  if (readiness.emergencyStop !== 'registered') throw new Error(`Global shortcuts were not registered: ${JSON.stringify(readiness)}`)

  await pressShortcut()
  const overlayTarget = await targetWhenReady((target) => target.url?.includes('omni-overlay.html'))
  const overlay = await connection(overlayTarget)
  try {
    const deadline = Date.now() + 10_000
    let state
    while (Date.now() < deadline) {
      state = await overlay.evaluate(`return {
        phase: [...(document.querySelector('.omni-voice-overlay')?.classList ?? [])].find((name) => name.startsWith('phase-')) ?? '',
        text: document.querySelector('.omni-voice-overlay')?.textContent ?? ''
      }`)
      if (state.phase && state.phase !== 'phase-idle') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!state?.phase || state.phase === 'phase-idle') throw new Error(`The global shortcut did not activate Omni: ${JSON.stringify(state)}`)
    await pressShortcut()
    await new Promise((resolve) => setTimeout(resolve, 250))
    const overlayTargets = (await targets()).filter((target) => target.type === 'page' && target.url?.includes('omni-overlay.html'))
    if (overlayTargets.length !== 1) throw new Error(`Repeated activation created ${overlayTargets.length} overlay renderers.`)
    await overlay.evaluate(`return await window.omniOverlay.activation.hide()`)
    console.log(JSON.stringify({ shortcut: 'CommandOrControl+Shift+Space', activations: 2, overlayTargets: 1, state, readiness }, null, 2))
  } finally {
    overlay.socket.close()
  }
} finally {
  await main.evaluate(`return await window.omnicode.omni.settings.update({ enabled: ${JSON.stringify(original.enabled)}, setupCompleted: ${JSON.stringify(original.setupCompleted)} })`).catch(() => undefined)
  main.socket.close()
}
