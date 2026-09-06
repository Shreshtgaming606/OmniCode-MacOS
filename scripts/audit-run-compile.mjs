import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9350)
let workspace = process.argv[3]
if (!workspace) throw new Error('Usage: node scripts/audit-run-compile.mjs <debug-port> <workspace>')
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

const result = await evaluate(`
  const workspace = ${JSON.stringify(workspace)}
  const initialTree = await window.omnicode.workspace.readTree(workspace)
  if (initialTree.some((entry) => entry.name === '.omnicode')) throw new Error('Use a disposable workspace without an existing .omnicode directory for this audit.')
  const auditRoot = await window.omnicode.workspace.createEntry(workspace, ${JSON.stringify(`OmniCode Run Audit ${Date.now()}`)}, 'directory')
  const files = new Map()
  const fixtures = ${JSON.stringify({
    'hello.py': "print('PYTHON_OK')\n",
    'hello.js': "console.log('NODE_OK')\n",
    'hello.c': "#include <stdio.h>\nint main(void) { puts(\"C_OK\"); return 0; }\n",
    'hello.cpp': "#include <iostream>\nint main() { std::cout << \"CPP_OK\\n\"; return 0; }\n",
    'hello.swift': "print(\"SWIFT_OK\")\n",
    'HelloJava.java': "public class HelloJava { public static void main(String[] args) { System.out.println(\"JAVA_OK\"); } }\n",
    'broken.py': "if True print('broken')\n",
    'broken.js': "throw new Error('NODE_EXPECTED_FAILURE')\n",
    'broken.c': "int main(void) { this is not valid C; }\n",
    'missing.ts': "console.log('TS_SHOULD_NOT_RUN')\n",
    'missing.rs': "fn main() { println!(\"RUST_OK\"); }\n",
    'missing.go': "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"GO_OK\") }\n",
    'unknown.xyz': "unknown\n"
  })}
  for (const [name, content] of Object.entries(fixtures)) {
    const path = await window.omnicode.workspace.createEntry(auditRoot, name, 'file')
    await window.omnicode.workspace.writeFile(path, content)
    files.set(name, path)
  }

  const chunks = new Map()
  const stopData = window.omnicode.terminal.onData(({ id, data }) => chunks.set(id, (chunks.get(id) || '') + data))
  const waitFor = (id, marker, timeoutMs = 180000) => new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      const output = chunks.get(id) || ''
      if (output.includes(marker)) return resolve(output)
      if (Date.now() - started >= timeoutMs) return reject(new Error('Timed out waiting for ' + marker + '; output=' + JSON.stringify(output)))
      setTimeout(poll, 75)
    }
    poll()
  })
  const quote = (value) => "'" + value.replaceAll("'", "'\\\\''") + "'"
  let sequence = 0
  const execute = async (name) => {
    const configuration = await window.omnicode.run.resolve(files.get(name), workspace)
    const token = 'run_' + (++sequence) + '_'
    const command = [quote(configuration.command), ...configuration.args.map(quote)].join(' ') +
      "; exit_code=$?; printf '%s%s%d\\\\n' '__OMNI_EXIT_' '" + token + "' \\\"$exit_code\\\""
    const session = await window.omnicode.terminal.create({ cwd: configuration.cwd, shell: '/bin/zsh', name: 'Run ' + name })
    window.omnicode.terminal.write(session.id, command + '\\r')
    const output = await waitFor(session.id, '__OMNI_EXIT_' + token)
    await window.omnicode.terminal.kill(session.id)
    const match = output.match(new RegExp('__OMNI_EXIT_' + token + '(\\\\d+)'))
    if (!match) throw new Error('Exit code marker was not parsed for ' + name)
    return { name, configuration, output, exitCode: Number(match[1]) }
  }

  const runs = []
  for (const name of ['hello.py', 'hello.js', 'hello.c', 'hello.cpp', 'hello.swift', 'HelloJava.java', 'broken.py', 'broken.js', 'broken.c', 'missing.ts']) {
    runs.push(await execute(name))
  }
  const rust = await window.omnicode.run.resolve(files.get('missing.rs'), workspace)
  const go = await window.omnicode.run.resolve(files.get('missing.go'), workspace)
  let unknownError = ''
  try { await window.omnicode.run.resolve(files.get('unknown.xyz'), workspace) }
  catch (error) { unknownError = String(error) }
  stopData()
  await window.omnicode.workspace.trashEntry(auditRoot)
  const finalTree = await window.omnicode.workspace.readTree(workspace)
  const generatedMetadata = finalTree.find((entry) => entry.name === '.omnicode')
  if (generatedMetadata) await window.omnicode.workspace.trashEntry(generatedMetadata.path)
  return { auditRoot, runs, rust, go, unknownError }
`)

const stripTerminal = (value) => value
  .replaceAll('\r', '')
  .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  .replaceAll('\b', '')
const byName = new Map(result.runs.map((run) => [run.name, { ...run, output: stripTerminal(run.output) }]))
const successExpectations = new Map([
  ['hello.py', 'PYTHON_OK'], ['hello.js', 'NODE_OK'], ['hello.c', 'C_OK'],
  ['hello.cpp', 'CPP_OK'], ['hello.swift', 'SWIFT_OK'], ['HelloJava.java', 'JAVA_OK']
])
for (const [name, marker] of successExpectations) {
  const run = byName.get(name)
  if (!run || run.exitCode !== 0 || !run.output.includes(marker)) {
    throw new Error(`${name} failed: ${JSON.stringify(run)}`)
  }
}
for (const name of ['broken.py', 'broken.js', 'broken.c', 'missing.ts']) {
  const run = byName.get(name)
  if (!run || run.exitCode === 0) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(run)}`)
}
if (!/SyntaxError|syntax/iu.test(byName.get('broken.py').output)) throw new Error('Python syntax error was not understandable.')
if (!/NODE_EXPECTED_FAILURE|Error/iu.test(byName.get('broken.js').output)) throw new Error('Node runtime error was not understandable.')
if (!/error:/iu.test(byName.get('broken.c').output)) throw new Error('Clang compiler error was not understandable.')
if (!/npm|npx|tsx|could not determine|not found/iu.test(byName.get('missing.ts').output)) throw new Error('Missing TypeScript dependency error was not understandable.')
if (result.rust.requiredTool !== 'rustc' || result.go.requiredTool !== 'go') {
  throw new Error(`Missing runtime requirements were not reported: ${JSON.stringify({ rust: result.rust, go: result.go })}`)
}
if (!/does not have an automatic run configuration/iu.test(result.unknownError)) {
  throw new Error(`Unknown file error was not useful: ${result.unknownError}`)
}
if (await fs.stat(result.auditRoot).then(() => true, () => false)) throw new Error('Run audit directory was not removed from the workspace.')

const uiFileName = `OmniCode UI Run ${Date.now()}.js`
const uiFile = await evaluate(`
  const path = await window.omnicode.workspace.createEntry(${JSON.stringify(workspace)}, ${JSON.stringify(uiFileName)}, 'file')
  await window.omnicode.workspace.writeFile(path, "console.log('RUN_UI_OK')\\n")
  return path
`)
await waitFor(`[...document.querySelectorAll('.tree-row')].some((row) => row.querySelector('.tree-label')?.textContent === ${JSON.stringify(uiFileName)})`)
await evaluate(`
  const row = [...document.querySelectorAll('.tree-row')].find((item) => item.querySelector('.tree-label')?.textContent === ${JSON.stringify(uiFileName)})
  row.click()
  return true
`)
await waitFor(`[...document.querySelectorAll('.editor-tabs button')].some((button) => button.title === ${JSON.stringify(uiFile)})`)
await evaluate(`document.querySelector('.run-button').click(); return true`)
await waitFor(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes('RUN_UI_OK')`, 60_000)
await waitFor(`document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes('[Process exited with code 0]')`, 60_000)
const uiRunOutput = await evaluate(`return document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent || ''`)
await evaluate(`await window.omnicode.workspace.trashEntry(${JSON.stringify(uiFile)}); return true`)
if (!uiRunOutput.includes('RUN_UI_OK') || !uiRunOutput.includes('[Process exited with code 0]')) {
  throw new Error(`Packaged Run UI did not show output and exit code: ${JSON.stringify(uiRunOutput)}`)
}
const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()

console.log(JSON.stringify({
  passed: [...successExpectations.keys()],
  expectedFailures: ['broken.py', 'broken.js', 'broken.c', 'missing.ts'],
  blockedMissingRuntimes: { rust: result.rust.requiredTool, go: result.go.requiredTool },
  unknownFileError: true,
  packagedRunUi: { stdout: true, exitCode: 0 },
  runtimeErrors: unexpectedErrors
}, null, 2))
