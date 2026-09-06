import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'

const port = Number(process.argv[2] ?? 9350)
let workspace = process.argv[3]
if (!workspace) throw new Error('Usage: node scripts/audit-terminal-runtime.mjs <debug-port> <workspace>')
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

await call('Runtime.enable')
await call('Log.enable')

const terminalResult = await evaluate(`
  const workspace = ${JSON.stringify(workspace)}
  const chunks = new Map()
  const exits = []
  const waiters = []
  const stopData = window.omnicode.terminal.onData(({ id, data }) => {
    chunks.set(id, (chunks.get(id) || '') + data)
    for (const waiter of [...waiters]) {
      if (waiter.id === id && chunks.get(id).includes(waiter.marker)) {
        clearTimeout(waiter.timeout)
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(chunks.get(id))
      }
    }
  })
  const stopExit = window.omnicode.terminal.onExit((event) => exits.push(event))
  const waitFor = (id, marker, timeoutMs = 12000) => {
    if ((chunks.get(id) || '').includes(marker)) return Promise.resolve(chunks.get(id))
    return new Promise((resolve, reject) => {
      const waiter = { id, marker, resolve, reject, timeout: 0 }
      waiter.timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error('Timed out waiting for terminal marker ' + marker + '; output=' + JSON.stringify(chunks.get(id) || '')))
      }, timeoutMs)
      waiters.push(waiter)
    })
  }

  const shells = await window.omnicode.terminal.listShells()
  let outsideRejected = false
  try { await window.omnicode.terminal.create({ cwd: '/etc', shell: '/bin/zsh', name: 'Outside' }) }
  catch (error) { outsideRejected = /outside|workspace/i.test(String(error)) }

  const first = await window.omnicode.terminal.create({ cwd: workspace, shell: '/bin/zsh', name: 'Audit One' })
  const probe = ${JSON.stringify("printf '%s%s\\n' '__OMNI_' 'TERM_BEGIN__'; printf 'PWD=%s\\n' \"$PWD\"; printf 'WHO=%s\\n' \"$(whoami)\"; printf 'TERM_PROGRAM=%s\\n' \"$TERM_PROGRAM\"; [[ :$PATH: == *:/usr/local/bin:* ]] && printf 'INTEL_BREW=yes\\n' || printf 'INTEL_BREW=no\\n'; [[ :$PATH: == *:/opt/homebrew/bin:* ]] && printf 'ARM_BREW=yes\\n' || printf 'ARM_BREW=no\\n'; printf 'NODE=%s\\n' \"$(command -v node)\"; printf 'GIT=%s\\n' \"$(command -v git)\"; printf '%s%s\\n' '__OMNI_' 'TERM_END__'")} + '\\r'
  window.omnicode.terminal.write(first.id, probe)
  const firstOutput = await waitFor(first.id, '__OMNI_TERM_END__')
  window.omnicode.terminal.resize(first.id, 132, 40)
  window.omnicode.terminal.resize(first.id, 5000, 5000)

  const beforeInterrupt = chunks.get(first.id).length
  window.omnicode.terminal.write(first.id, ${JSON.stringify("sleep 30 && printf '__UNEXPECTED_AFTER_SLEEP__\\n'")} + '\\r')
  await new Promise((resolve) => setTimeout(resolve, 400))
  window.omnicode.terminal.write(first.id, '\\u0003')
  await new Promise((resolve) => setTimeout(resolve, 250))
  window.omnicode.terminal.write(first.id, ${JSON.stringify("printf '%s%s\\n' '__OMNI_' 'INTERRUPTED__'")} + '\\r')
  await waitFor(first.id, '__OMNI_INTERRUPTED__')
  const interruptOutput = chunks.get(first.id).slice(beforeInterrupt)

  const second = await window.omnicode.terminal.create({ cwd: workspace, shell: '/bin/zsh', name: 'Audit Two' })
  window.omnicode.terminal.write(second.id, ${JSON.stringify("printf '%s%s\\n' '__OMNI_' 'SECOND_SESSION__'")} + '\\r')
  const secondOutput = await waitFor(second.id, '__OMNI_SECOND_SESSION__')

  const restarted = await window.omnicode.terminal.restart(first.id)
  window.omnicode.terminal.write(restarted.id, ${JSON.stringify("printf '%s%s\\n' '__OMNI_' 'RESTARTED__'")} + '\\r')
  const restartedOutput = await waitFor(restarted.id, '__OMNI_RESTARTED__')

  await window.omnicode.terminal.kill(second.id)
  await window.omnicode.terminal.kill(restarted.id)
  await new Promise((resolve) => setTimeout(resolve, 300))
  stopData()
  stopExit()
  return {
    shells, outsideRejected, first, second, restarted,
    firstOutput, interruptOutput, secondOutput, restartedOutput, exits,
    terminalUi: Boolean(document.querySelector('.terminal-panel__screen .xterm'))
  }
`)

const normalized = (value) => value.replaceAll('\r', '')
const firstOutput = normalized(terminalResult.firstOutput)
const interruptOutput = normalized(terminalResult.interruptOutput)
const plainFirstOutput = firstOutput.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '').replaceAll('\b', '')
const lastLineValue = (name) => [...plainFirstOutput.matchAll(new RegExp(`^${name}=([^\\n]+)$`, 'gmu'))].at(-1)?.[1]
if (!terminalResult.shells.includes('/bin/zsh')) throw new Error('The packaged app did not list /bin/zsh.')
if (!terminalResult.outsideRejected) throw new Error('A terminal was allowed to start outside the authorized workspace.')
if (terminalResult.first.cwd !== workspace || terminalResult.second.cwd !== workspace || terminalResult.restarted.cwd !== workspace) {
  throw new Error(`Terminal cwd mismatch: ${JSON.stringify(terminalResult)}`)
}
for (const expected of [
  `PWD=${workspace}`, 'TERM_PROGRAM=OmniCode', 'INTEL_BREW=yes', 'ARM_BREW=yes', '__OMNI_TERM_END__'
]) {
  if (!plainFirstOutput.includes(expected)) throw new Error(`Terminal environment is missing ${expected}. Output: ${JSON.stringify(plainFirstOutput)}`)
}
if (!lastLineValue('WHO') || !lastLineValue('NODE') || !lastLineValue('GIT')) {
  throw new Error(`Terminal identity or PATH command lookup failed: ${plainFirstOutput}`)
}
if (!interruptOutput.includes('^C') || !interruptOutput.includes('__OMNI_INTERRUPTED__')) {
  throw new Error(`Ctrl+C did not interrupt the terminal process: ${interruptOutput}`)
}
const plainInterruptOutput = interruptOutput.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '').replaceAll('\b', '')
if (/(?:^|\n)__UNEXPECTED_AFTER_SLEEP__(?:\n|$)/u.test(plainInterruptOutput)) {
  throw new Error(`The interrupted command continued running: ${interruptOutput}`)
}
if (!terminalResult.secondOutput.includes('__OMNI_SECOND_SESSION__') || !terminalResult.restartedOutput.includes('__OMNI_RESTARTED__')) {
  throw new Error('Multiple-session or restart markers were not observed.')
}
if (!terminalResult.terminalUi) throw new Error('The xterm terminal UI was not mounted.')

const detectedTools = await evaluate(`return await window.omnicode.tools.detect()`)
const commandByTool = new Map([
  ['xcode-command-line-tools', 'xcode-select'], ['homebrew', 'brew'], ['git', 'git'],
  ['clang', 'clang'], ['clang++', 'clang++'], ['swift', 'swift'], ['python3', 'python3'],
  ['node', 'node'], ['npm', 'npm'], ['java', 'java'], ['javac', 'javac'], ['dotnet', 'dotnet'],
  ['rustc', 'rustc'], ['cargo', 'cargo'], ['go', 'go'], ['ruby', 'ruby'], ['php', 'php'], ['ollama', 'ollama']
])
const detectionMismatches = []
for (const [id, command] of commandByTool) {
  const tool = detectedTools.find((candidate) => candidate.id === id)
  const hostInstalled = spawnSync('/bin/zsh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).status === 0
  if (!tool || tool.installed !== hostInstalled) detectionMismatches.push({ id, hostInstalled, detected: tool?.installed })
}
if (detectionMismatches.length) throw new Error(`Runtime detection mismatches: ${JSON.stringify(detectionMismatches)}`)

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()

console.log(JSON.stringify({
  terminal: {
    shells: terminalResult.shells,
    cwd: workspace,
    identity: lastLineValue('WHO'),
    node: lastLineValue('NODE'),
    git: lastLineValue('GIT'),
    intelHomebrewPath: true,
    appleSiliconHomebrewPath: true,
    ctrlC: true,
    multipleSessions: true,
    restart: true,
    resize: true,
    outsideWorkspaceRejected: true,
    uiMounted: true
  },
  runtimes: Object.fromEntries([...commandByTool.keys()].map((id) => [id, detectedTools.find((tool) => tool.id === id)?.installed ?? false])),
  runtimeErrors: unexpectedErrors
}, null, 2))
