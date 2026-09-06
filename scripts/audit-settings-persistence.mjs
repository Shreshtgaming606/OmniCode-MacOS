import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9352)
const root = await fs.realpath(process.argv[3] ?? '')
const mode = process.argv[4] ?? 'set'
const snapshotKey = 'omnicode.audit.preferenceSnapshot'

async function rendererTarget() {
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

const target = await rendererTarget()
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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
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
await waitFor(`document.querySelector('.workspace-heading')?.getAttribute('title') === ${JSON.stringify(root)}`)

if (mode === 'set') {
  const workspace = await evaluate(`
    const root = ${JSON.stringify(root)}
    const valid = {
      editor: { autosave: false, tabSize: 4 },
      ai: { provider: 'google', chatModel: 'gemini-3.5-flash', exclusions: ['ignored.ts'] },
      agentPermissions: 'workspace'
    }
    await window.omnicode.settings.write(root, valid)
    const roundTrip = await window.omnicode.settings.read(root)
    let invalidError = ''
    try { await window.omnicode.settings.write(root, { developmentServer: { port: 70000 } }) }
    catch (error) { invalidError = String(error) }
    const retained = await window.omnicode.settings.read(root)
    const file = await window.omnicode.workspace.readFile(root + '/.omnicode/settings.json')
    await window.omnicode.workspace.writeFile(root + '/.omnicode/settings.json', '{ invalid json', file.modifiedAt)
    let corruptError = ''
    try { await window.omnicode.settings.read(root) } catch (error) { corruptError = String(error) }
    await window.omnicode.settings.write(root, {})
    return { roundTrip, retained, invalidError, corruptError }
  `)
  const fileMode = (await fs.stat(`${root}/.omnicode/settings.json`)).mode & 0o777
  if (workspace.roundTrip.editor?.tabSize !== 4 || workspace.retained.editor?.tabSize !== 4 || !/65535/u.test(workspace.invalidError) || !/not valid JSON/iu.test(workspace.corruptError) || fileMode !== 0o600) {
    throw new Error(`Workspace settings validation/persistence failed: ${JSON.stringify({ workspace, fileMode })}`)
  }

  await evaluate(`
    const keys = ['omnicode.theme', 'omnicode.autosave', 'omnicode.permission', 'omnicode.aiAutocomplete', 'omnicode.autocompleteProvider', 'omnicode.autocompleteModel']
    const snapshot = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]))
    if (!localStorage.getItem(${JSON.stringify(snapshotKey)})) localStorage.setItem(${JSON.stringify(snapshotKey)}, JSON.stringify(snapshot))
    document.querySelector('button[aria-label="Close change review"]')?.click()
    document.querySelector('button[title="Settings"]').click()
    return true
  `)
  await waitFor(`document.querySelector('.settings-panel')`)
  await evaluate(`
    const light = [...document.querySelectorAll('#appearance .segmented button')].find((button) => button.textContent === 'Light')
    light.click()
    const autosave = document.querySelector('#files input[type="checkbox"]')
    if (!autosave.checked) autosave.click()
    const agent = [...document.querySelectorAll('.permission-options button')].find((button) => button.textContent.includes('Agent Mode'))
    agent.click()
    const autocomplete = document.querySelector('#autocomplete .setting-toggle input[type="checkbox"]')
    if (autocomplete.checked) autocomplete.click()
    const provider = document.querySelector('#autocomplete select')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(provider, 'google')
    provider.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  `)
  await waitFor(`document.querySelector('#autocomplete .autocomplete-setting input')`)
  await evaluate(`
    const model = document.querySelector('#autocomplete .autocomplete-setting input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(model, 'gemini-3.5-flash')
    model.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    return true
  `)
  const preferences = await evaluate(`return {
    theme: localStorage.getItem('omnicode.theme'),
    autosave: localStorage.getItem('omnicode.autosave'),
    permission: localStorage.getItem('omnicode.permission'),
    aiAutocomplete: localStorage.getItem('omnicode.aiAutocomplete'),
    provider: localStorage.getItem('omnicode.autocompleteProvider'),
    model: localStorage.getItem('omnicode.autocompleteModel'),
    datasetTheme: document.documentElement.dataset.theme
  }`)
  if (JSON.stringify(preferences) !== JSON.stringify({ theme: 'light', autosave: 'true', permission: 'agent', aiAutocomplete: 'false', provider: 'google', model: 'gemini-3.5-flash', datasetTheme: 'light' })) {
    throw new Error(`UI preferences were not applied: ${JSON.stringify(preferences)}`)
  }
  socket.close()
  console.log(JSON.stringify({ workspace: { ...workspace, fileMode: fileMode.toString(8) }, preferences, runtimeErrors }, null, 2))
} else if (mode === 'verify-and-restore') {
  await evaluate(`document.querySelector('button[title="Settings"]').click(); return true`)
  await waitFor(`document.querySelector('.settings-panel')`)
  const persisted = await evaluate(`
    const selectedTheme = [...document.querySelectorAll('#appearance .segmented button')].find((button) => button.classList.contains('active'))?.textContent || ''
    const selectedPermission = [...document.querySelectorAll('.permission-options button')].find((button) => button.classList.contains('active'))?.textContent || ''
    return {
      datasetTheme: document.documentElement.dataset.theme,
      selectedTheme,
      autosave: document.querySelector('#files input[type="checkbox"]').checked,
      selectedPermission,
      aiAutocomplete: document.querySelector('#autocomplete .setting-toggle input[type="checkbox"]').checked,
      provider: document.querySelector('#autocomplete select').value,
      model: document.querySelector('#autocomplete .autocomplete-setting input')?.value || '',
      workspace: await window.omnicode.settings.read(${JSON.stringify(root)})
    }
  `)
  if (persisted.datasetTheme !== 'light' || persisted.selectedTheme !== 'Light' || !persisted.autosave || !persisted.selectedPermission.includes('Agent Mode') || persisted.aiAutocomplete || persisted.provider !== 'google' || persisted.model !== 'gemini-3.5-flash' || Object.keys(persisted.workspace).length) {
    throw new Error(`Preferences did not survive restart: ${JSON.stringify(persisted)}`)
  }
  const restored = await evaluate(`
    const snapshot = JSON.parse(localStorage.getItem(${JSON.stringify(snapshotKey)}) || '{}')
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }
    localStorage.removeItem(${JSON.stringify(snapshotKey)})
    await window.omnicode.workspace.trashEntry(${JSON.stringify(`${root}/.omnicode`)})
    return snapshot
  `)
  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  socket.close()
  console.log(JSON.stringify({ persisted, restoredSnapshot: Object.keys(restored), cleanup: true, runtimeErrors: unexpectedErrors }, null, 2))
} else {
  throw new Error(`Unknown mode: ${mode}`)
}
