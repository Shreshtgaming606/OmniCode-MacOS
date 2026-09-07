import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number(process.argv[2] ?? 9386)
const workspace = await fs.realpath(process.argv[3] ?? '')
const fixtureName = 'editor-clipboard-audit.txt'
const fixturePath = path.join(workspace, fixtureName)
const originalContent = 'EDITOR_COPY_ORIGINAL\nalpha beta alpha\n'
const pastedContent = 'EDITOR_PASTE_REPLACEMENT\nalpha beta alpha\n'
const replacedContent = 'EDITOR_PASTE_REPLACEMENT\nomega beta omega\n'
const auditToken = `${process.pid}_${Date.now()}`
const pasteMarker = `__TERM_CLIP_PASTE_${auditToken}__`
const copyMarker = `__TERM_COPY_${auditToken}__`

async function apple(expression) {
  return (await execFileAsync('/usr/bin/osascript', ['-e', expression])).stdout.trim()
}
async function readClipboard() {
  return (await execFileAsync('/usr/bin/pbpaste', [])).stdout
}
async function writeClipboard(value) {
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', [])
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`)))
    child.stdin.end(value)
  })
}
async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}
async function shortcut(character, modifiers = '{command down}') {
  await apple('tell application "OmniCode" to activate')
  await waitFor(
    async () => (await apple('tell application "System Events" to tell process "OmniCode" to get frontmost')) === 'true',
    'OmniCode to become frontmost'
  )
  await apple(`tell application "System Events" to tell process "OmniCode" to keystroke ${JSON.stringify(character)} using ${modifiers}`)
}

let target
await waitFor(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).catch(() => [])
  target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  return Boolean(target)
}, 'packaged renderer')
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
async function setInput(selector, value) {
  await evaluate(`
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('Missing input: ' + ${JSON.stringify(selector)})
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
}

const previousClipboard = await readClipboard().catch(() => '')
let fixtureCreated = false
try {
  await call('Runtime.enable')
  await call('Log.enable')
  await waitFor(async () => evaluate(`return Boolean(window.omnicode && document.querySelector('.app-shell'))`), 'workbench')
  await fs.writeFile(fixturePath, originalContent)
  fixtureCreated = true

  await shortcut('p')
  await waitFor(async () => evaluate(`return Boolean(document.querySelector('.palette input[placeholder="Search files by name"]'))`), 'Quick Open')
  await setInput('.palette input[placeholder="Search files by name"]', fixtureName)
  await waitFor(async () => evaluate(`return [...document.querySelectorAll('.palette-results button strong')].some((item) => item.textContent === ${JSON.stringify(fixtureName)})`), 'fixture in Quick Open')
  await evaluate(`
    const item = [...document.querySelectorAll('.palette-results button strong')].find((candidate) => candidate.textContent === ${JSON.stringify(fixtureName)})
    item.closest('button').click()
    return true
  `)
  await waitFor(async () => evaluate(`return document.querySelector('.editor-tabs button[title$="/${fixtureName}"]')?.classList.contains('active')`), 'fixture editor tab')

  await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
  await shortcut('a')
  await waitFor(async () => evaluate(`return document.querySelectorAll('.monaco-editor .selected-text').length > 0`), 'Monaco select all')
  await shortcut('c')
  await waitFor(async () => await readClipboard() === originalContent, 'editor copy to system clipboard')

  await writeClipboard(pastedContent)
  await shortcut('a')
  await shortcut('v')
  await waitFor(async () => evaluate(`return Boolean(document.querySelector('.editor-tabs button[title$="/${fixtureName}"] .dirty-dot'))`), 'editor paste dirty state')

  await shortcut('f', '{command down, option down}')
  await waitFor(async () => evaluate(`return Boolean(document.querySelector('.find-widget'))`), 'Monaco Find/Replace widget')
  const replaceVisible = await evaluate(`
    const part = document.querySelector('.find-widget .replace-part')
    return Boolean(part && getComputedStyle(part).display !== 'none')
  `)
  if (!replaceVisible) await evaluate(`document.querySelector('.find-widget .button.toggle')?.click(); return true`)
  await waitFor(async () => evaluate(`
    const part = document.querySelector('.find-widget .replace-part')
    return Boolean(part && getComputedStyle(part).display !== 'none' && part.querySelector('.monaco-findInput textarea'))
  `), 'Monaco Replace input')
  await setInput('.find-widget .find-part .monaco-findInput textarea', 'alpha')
  await setInput('.find-widget .replace-part .monaco-findInput textarea', 'omega')
  await waitFor(async () => evaluate(`return document.querySelector('.find-widget [aria-label^="Replace All"]')?.getAttribute('aria-disabled') === 'false'`), 'Replace All enablement')
  await evaluate(`document.querySelector('.find-widget [aria-label^="Replace All"]').click(); return true`)
  await shortcut('s')
  await waitFor(async () => await fs.readFile(fixturePath, 'utf8') === replacedContent, 'inline Replace All and Save bytes')

  await evaluate(`
    const close = document.querySelector('.editor-tabs button[title$="/${fixtureName}"] .tab-close')
    close?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  `)
  await waitFor(async () => evaluate(`return !document.querySelector('.editor-tabs button[title$="/${fixtureName}"]')`), 'fixture tab close')

  await waitFor(async () => evaluate(`return Boolean(document.querySelector('.terminal-panel__screen.is-active .xterm-helper-textarea'))`), 'active terminal')
  await writeClipboard(`printf '${pasteMarker}\\n'`)
  await evaluate(`document.querySelector('.terminal-panel__screen.is-active .xterm-helper-textarea').focus(); return true`)
  await shortcut('v')
  await apple('tell application "System Events" to tell process "OmniCode" to key code 36')
  await waitFor(async () => evaluate(`return document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes(${JSON.stringify(pasteMarker)})`), 'terminal clipboard paste output')

  await writeClipboard(`for i in {1..500}; do printf 'SCROLL_%04d\\n' $i; done; printf '${copyMarker}\\n'`)
  await shortcut('v')
  await apple('tell application "System Events" to tell process "OmniCode" to key code 36')
  await waitFor(async () => evaluate(`return document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes(${JSON.stringify(copyMarker)})`), 'long terminal output')
  const scroll = await evaluate(`
    const rows = [...document.querySelectorAll('.terminal-panel__screen.is-active .xterm-accessibility-tree [role="listitem"]')]
    const track = document.querySelector('.terminal-panel__screen.is-active .xterm-scrollable-element > .scrollbar.vertical').getBoundingClientRect()
    const slider = document.querySelector('.terminal-panel__screen.is-active .xterm-scrollable-element > .scrollbar.vertical .slider').getBoundingClientRect()
    return {
      firstPosition: Number(rows[0]?.getAttribute('aria-posinset')),
      totalRows: Number(rows[0]?.getAttribute('aria-setsize')),
      visibleRows: rows.length,
      slider: { x: slider.left + slider.width / 2, y: slider.top + slider.height / 2 },
      track: { top: track.top, bottom: track.bottom }
    }
  `)
  if (scroll.totalRows < 500 || scroll.firstPosition < 2) throw new Error(`Terminal scrollback was not populated: ${JSON.stringify(scroll)}`)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: scroll.slider.x, y: scroll.slider.y })
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: scroll.slider.x, y: scroll.slider.y, button: 'left', buttons: 1, clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: scroll.slider.x, y: scroll.track.top + 10, button: 'left', buttons: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: scroll.slider.x, y: scroll.track.top + 10, button: 'left', buttons: 0, clickCount: 1 })
  await waitFor(async () => evaluate(`
    const first = document.querySelector('.terminal-panel__screen.is-active .xterm-accessibility-tree [role="listitem"]')
    return Number(first?.getAttribute('aria-posinset')) < ${scroll.firstPosition}
  `), 'terminal scrollback upward movement')
  const scrolledPosition = await evaluate(`
    return Number(document.querySelector('.terminal-panel__screen.is-active .xterm-accessibility-tree [role="listitem"]')?.getAttribute('aria-posinset'))
  `)
  const currentSlider = await evaluate(`
    const slider = document.querySelector('.terminal-panel__screen.is-active .xterm-scrollable-element > .scrollbar.vertical .slider').getBoundingClientRect()
    return { x: slider.left + slider.width / 2, y: slider.top + slider.height / 2 }
  `)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: currentSlider.x, y: currentSlider.y, button: 'left', buttons: 1, clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: currentSlider.x, y: scroll.track.bottom - 2, button: 'left', buttons: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: currentSlider.x, y: scroll.track.bottom - 2, button: 'left', buttons: 0, clickCount: 1 })
  await waitFor(async () => evaluate(`return document.querySelector('.terminal-panel__screen.is-active .xterm-rows')?.textContent.includes(${JSON.stringify(copyMarker)})`), 'terminal marker after scrolling')
  const markerPoint = await evaluate(`
    const row = [...document.querySelectorAll('.terminal-panel__screen.is-active .xterm-rows > div')].find((item) => item.textContent.includes(${JSON.stringify(copyMarker)}))
    const rect = row.getBoundingClientRect()
    return { x: rect.left + 30, y: rect.top + rect.height / 2 }
  `)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: markerPoint.x, y: markerPoint.y, button: 'left', clickCount: 3 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: markerPoint.x, y: markerPoint.y, button: 'left', clickCount: 3 })
  await shortcut('c')
  await waitFor(async () => (await readClipboard()).includes(copyMarker), 'terminal selection copy to system clipboard')

  const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
  if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
  console.log(JSON.stringify({
    editor: { systemCopy: true, systemPaste: true, inlineReplaceAll: true, exactSavedBytes: true },
    terminal: { systemPaste: true, systemCopy: true, scrollLines: 500, totalRows: scroll.totalRows, firstPosition: scroll.firstPosition, scrolledPosition },
    cleanup: { fixtureRemoved: true, clipboardRestored: true },
    runtimeErrors: unexpectedErrors
  }, null, 2))
} finally {
  await writeClipboard(previousClipboard).catch(() => undefined)
  if (fixtureCreated) await fs.rm(fixturePath, { force: true })
  socket.close()
}
