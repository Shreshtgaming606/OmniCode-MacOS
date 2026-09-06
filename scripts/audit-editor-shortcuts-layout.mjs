import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const port = Number(process.argv[2] ?? 9352)
const workspace = await fs.realpath(process.argv[3] ?? '')

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
async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`return Boolean(${expression})`).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
async function shortcut(key, code, modifiers = 4, virtualKey = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0) {
  const common = { modifiers, key, code, windowsVirtualKeyCode: virtualKey }
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}
async function escape() {
  await shortcut('Escape', 'Escape', 0, 27)
}
async function macShortcut(character, modifiers = ['command down']) {
  if (!/^[a-z`,]$/u.test(character) || modifiers.some((modifier) => !['command down', 'shift down', 'control down', 'option down'].includes(modifier))) {
    throw new Error('Refusing an unsupported native shortcut.')
  }
  await execFileAsync('/usr/bin/osascript', [
    '-e', 'tell application "OmniCode" to activate',
    '-e', `tell application "System Events" to keystroke ${JSON.stringify(character)} using {${modifiers.join(', ')}}`
  ])
  await new Promise((resolve) => setTimeout(resolve, 250))
}
async function macKeyCode(keyCode) {
  if (![36, 53].includes(keyCode)) throw new Error('Refusing an unsupported native key code.')
  await execFileAsync('/usr/bin/osascript', [
    '-e', 'tell application "OmniCode" to activate',
    '-e', `tell application "System Events" to key code ${keyCode}`
  ])
  await new Promise((resolve) => setTimeout(resolve, 250))
}
async function setInput(selector, value) {
  return evaluate(`
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('Input is missing: ' + ${JSON.stringify(selector)})
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    return true
  `)
}
async function openByQuickOpen(name) {
  await macShortcut('p')
  await waitFor(`document.querySelector('.palette input[placeholder="Search files by name"]')`)
  await setInput('.palette input[placeholder="Search files by name"]', name)
  await waitFor(`[...document.querySelectorAll('.palette-results button strong')].some((item) => item.textContent === ${JSON.stringify(name)})`)
  await evaluate(`
    const strong = [...document.querySelectorAll('.palette-results button strong')].find((item) => item.textContent === ${JSON.stringify(name)})
    strong.closest('button').click()
    return true
  `)
  await waitFor(`document.querySelector('.editor-tabs button[title$="/${name}"]')`)
}

await call('Runtime.enable')
await call('Log.enable')
await waitFor(`window.omnicode && document.querySelector('.app-shell')`)
await waitFor(`document.querySelector('.command-center span')?.textContent === ${JSON.stringify(workspace.split('/').pop())}`)
const exactWorkspaceGranted = await evaluate(`
  try { await window.omnicode.workspace.readTree(${JSON.stringify(workspace)}); return true }
  catch { return false }
`)
if (!exactWorkspaceGranted) throw new Error(`The packaged app did not authorize the expected workspace: ${workspace}`)

const auditName = `OmniCode UI Audit ${Date.now()}`
const auditRoot = `${workspace}/${auditName}`
const names = { typescript: 'editor-audit.ts', python: 'editor-audit.py', markdown: 'editor-audit.md' }
const paths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, `${auditRoot}/${name}`]))
const searchPaths = [`${auditRoot}/search-one.txt`, `${auditRoot}/search-two.txt`]
const searchMarker = `OMNICODE_SEARCH_${Date.now()}`
const replacementMarker = `${searchMarker}_REPLACED`
const initialTypeScript = "const initial: string = 'editor'\n"
const originalTheme = await evaluate(`return localStorage.getItem('omnicode.theme')`)

await evaluate(`
  const root = await window.omnicode.workspace.createEntry(${JSON.stringify(workspace)}, ${JSON.stringify(auditName)}, 'directory')
  const files = ${JSON.stringify([...Object.values(names), 'search-one.txt', 'search-two.txt'])}
  for (const name of files) await window.omnicode.workspace.createEntry(root, name, 'file')
  await window.omnicode.workspace.writeFile(${JSON.stringify(paths.typescript)}, ${JSON.stringify(initialTypeScript)})
  await window.omnicode.workspace.writeFile(${JSON.stringify(paths.python)}, ${JSON.stringify("print('editor')\n")})
  await window.omnicode.workspace.writeFile(${JSON.stringify(paths.markdown)}, ${JSON.stringify('# Editor audit\n')})
  await window.omnicode.workspace.writeFile(${JSON.stringify(searchPaths[0])}, ${JSON.stringify(`first ${searchMarker}\n`)})
  await window.omnicode.workspace.writeFile(${JSON.stringify(searchPaths[1])}, ${JSON.stringify(`second ${searchMarker}\n`)})
  return true
`)
await waitFor(`document.querySelector('.command-center')?.textContent?.includes(${JSON.stringify(auditName)}) || true`, 1_000)

// Native macOS menu accelerators: quick open and command palette.
await openByQuickOpen(names.typescript)
await macShortcut('p', ['command down', 'shift down'])
await waitFor(`document.querySelector('.palette input[placeholder="Type a command"]')`)
const commandPaletteCount = await evaluate(`return document.querySelectorAll('.palette-results button').length`)
if (commandPaletteCount < 5) throw new Error(`Command palette was unexpectedly empty (${commandPaletteCount}).`)
await evaluate(`document.querySelector('.palette-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true`)
await waitFor(`!document.querySelector('.palette')`)

// Workspace search and confirmed Replace All through the actual sidebar UI.
await macShortcut('f', ['command down', 'shift down'])
await waitFor(`document.querySelector('.search-view input[aria-label="Search workspace"]')`)
await setInput('.search-view input[aria-label="Search workspace"]', searchMarker)
await evaluate(`document.querySelector('.search-submit').click(); return true`)
await waitFor(`document.querySelector('.result-summary')?.textContent === '2 results'`)
await evaluate(`document.querySelector('.replace-disclosure').click(); return true`)
await waitFor(`document.querySelector('.replace-box input[aria-label="Replace with"]')`)
await setInput('.replace-box input[aria-label="Replace with"]', replacementMarker)
await evaluate(`
  const original = window.confirm
  window.confirm = () => true
  document.querySelector('.replace-box button').click()
  window.confirm = original
  return true
`)
await waitFor(`document.querySelector('.search-notice')?.textContent?.includes('Replaced 2 occurrences')`)
if (!(await fs.readFile(searchPaths[0], 'utf8')).includes(replacementMarker) || !(await fs.readFile(searchPaths[1], 'utf8')).includes(replacementMarker)) {
  throw new Error('Workspace Replace All did not update both real files.')
}

// Multiple Monaco tabs and language detection.
await openByQuickOpen(names.python)
await openByQuickOpen(names.markdown)
const multipleTabs = await evaluate(`return ${JSON.stringify(Object.values(names))}.every((name) => Boolean(document.querySelector('.editor-tabs button[title$="/' + name + '"]')))`)
if (!multipleTabs) throw new Error('Quick Open did not create all three editor tabs.')
await macShortcut('w')
await waitFor(`!document.querySelector('.editor-tabs button[title$="/${names.markdown}"]')`)
await evaluate(`document.querySelector('.editor-tabs button[title$="/${names.typescript}"]').click(); return true`)
await waitFor(`document.querySelector('.status-bar')?.textContent?.includes('TypeScript') && document.querySelector('.monaco-editor .native-edit-context')`)

// Undo, redo, save, auto-indentation, line numbers, syntax tokens, folding, and minimap.
await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
await call('Input.insertText', { text: 'x' })
await waitFor(`document.querySelector('.editor-tabs button[title$="/${names.typescript}"] .dirty-dot')`)
await macShortcut('z')
await waitFor(`!document.querySelector('.editor-tabs button[title$="/${names.typescript}"] .dirty-dot')`)
await macShortcut('z', ['command down', 'shift down'])
await waitFor(`document.querySelector('.editor-tabs button[title$="/${names.typescript}"] .dirty-dot')`)
await macShortcut('s')
await waitFor(`!document.querySelector('.editor-tabs button[title$="/${names.typescript}"] .dirty-dot')`)
if (await fs.readFile(paths.typescript, 'utf8') !== `x${initialTypeScript}`) throw new Error('Cmd+S did not save the redone Monaco content.')

await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
await macShortcut('a')
await call('Input.insertText', { text: 'function autoIndentAudit() {' })
await macKeyCode(36)
await call('Input.insertText', { text: 'return 1' })
await macKeyCode(36)
await macShortcut('s')
await waitFor(`!document.querySelector('.editor-tabs button[title$="/${names.typescript}"] .dirty-dot')`)
const indentedText = await fs.readFile(paths.typescript, 'utf8')
const indentedLines = indentedText.split('\n')
const meaningfulLines = indentedLines.filter((line) => line.trim())
if (meaningfulLines[0] !== 'function autoIndentAudit() {' || !/^\s+return 1$/u.test(meaningfulLines[1] ?? '') || meaningfulLines.at(-1) !== '}') {
  throw new Error(`Monaco auto-indentation failed: ${JSON.stringify(indentedText)}`)
}
await waitFor(`document.querySelector('.monaco-editor .line-numbers') && document.querySelector('.monaco-editor .minimap')`)
const editorRendering = await evaluate(`return {
  lineNumbers: document.querySelectorAll('.monaco-editor .line-numbers').length,
  minimap: Boolean(document.querySelector('.monaco-editor .minimap')),
  syntaxTokens: document.querySelectorAll('.monaco-editor .view-line span[class*="mtk"]').length,
  foldingControls: document.querySelectorAll('.monaco-editor [class*="folding-"]').length
}`)
if (!editorRendering.lineNumbers || !editorRendering.minimap || !editorRendering.syntaxTokens || !editorRendering.foldingControls) {
  throw new Error(`Expected Monaco rendering affordances were missing: ${JSON.stringify(editorRendering)}`)
}

await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
await macShortcut('f')
await waitFor(`document.querySelector('.find-widget')?.classList.contains('visible')`)
await escape()

// Inline AI shortcut opens the existing selection workflow without contacting a provider.
await evaluate(`document.querySelector('.monaco-editor .native-edit-context').focus(); return true`)
await macShortcut('a')
await waitFor(`document.querySelectorAll('.monaco-editor .selected-text').length > 0`)
await macShortcut('i')
await waitFor(`document.querySelector('.inline-ai-overlay textarea[placeholder="Describe the change…"]')`)
await evaluate(`document.querySelector('.inline-ai-dialog footer button').click(); return true`)
await waitFor(`!document.querySelector('.inline-ai-overlay')`)

// Settings shortcut and rendered theme accessibility.
await macShortcut(',')
await waitFor(`document.querySelector('.settings-panel')`)
const themes = {}
for (const theme of ['Light', 'Dark', 'System']) {
  await evaluate(`
    const button = [...document.querySelectorAll('#appearance .segmented button')].find((item) => item.textContent === ${JSON.stringify(theme)})
    button.click()
    return true
  `)
  await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme.toLowerCase())}`)
  themes[theme.toLowerCase()] = await evaluate(`
    const style = getComputedStyle(document.documentElement)
    return { background: style.getPropertyValue('--bg-sidebar').trim(), text: style.getPropertyValue('--text-muted').trim(), accent: style.getPropertyValue('--accent').trim(), warning: style.getPropertyValue('--warning').trim() }
  `)
}
const focusAndDisabled = await evaluate(`
  const focused = document.querySelector('.settings-panel header button[title="Close settings"]')
  focused.focus()
  const focusStyle = getComputedStyle(focused)
  const disabled = document.querySelector('.breadcrumbs button[title="Save"]')
  return { outlineWidth: focusStyle.outlineWidth, outlineStyle: focusStyle.outlineStyle, disabledOpacity: disabled ? getComputedStyle(disabled).opacity : null }
`)
if (focusAndDisabled.outlineStyle === 'none' || Number.parseFloat(focusAndDisabled.outlineWidth) < 2 || Number.parseFloat(focusAndDisabled.disabledOpacity ?? '1') > 0.5) {
  throw new Error(`Focus or disabled state was not visually distinct: ${JSON.stringify(focusAndDisabled)}`)
}

function luminance(hex) {
  const components = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * components[0] + 0.7152 * components[1] + 0.0722 * components[2]
}
function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)]
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
}
for (const theme of ['light', 'dark']) {
  const values = themes[theme]
  const results = {
    muted: contrast(values.text, values.background),
    accent: contrast(values.accent, values.background),
    warning: contrast(values.warning, values.background)
  }
  themes[theme].contrast = results
  if (Object.values(results).some((value) => value < 4.5)) throw new Error(`${theme} theme contrast failed: ${JSON.stringify(results)}`)
}
await evaluate(`
  const target = ${JSON.stringify(originalTheme ?? 'system')}
  const label = target[0].toUpperCase() + target.slice(1)
  ;[...document.querySelectorAll('#appearance .segmented button')].find((item) => item.textContent === label)?.click()
  document.querySelector('.settings-panel header button[title="Close settings"]').click()
  return true
`)
await waitFor(`!document.querySelector('.settings-panel')`)

// Real pointer resize handlers and all three layout visibility controls.
await evaluate(`
  for (const title of ['Primary sidebar', 'Bottom panel', 'AI sidebar']) {
    const button = document.querySelector('button[title="' + title + '"]')
    if (!button.classList.contains('active')) button.click()
  }
  return true
`)
await waitFor(`document.querySelector('.primary-sidebar') && document.querySelector('.bottom-panel')?.style.display !== 'none' && document.querySelector('.ai-resizer + div')`)
async function dragLayout(selector, endX, endY) {
  await evaluate(`
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) throw new Error('Missing resize handle: ' + ${JSON.stringify(selector)})
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${endX}, clientY: ${endY}, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${endX}, clientY: ${endY}, pointerId: 1 }))
    return true
  `)
}
await dragLayout('.resize-handle.vertical:not(.ai-resizer)', 10_000, 0)
await waitFor(`Number.parseFloat(document.querySelector('.primary-sidebar').style.width) === 480`)
await dragLayout('.resize-handle.vertical:not(.ai-resizer)', -10_000, 0)
await waitFor(`Number.parseFloat(document.querySelector('.primary-sidebar').style.width) === 200`)
await dragLayout('.ai-resizer', -10_000, 0)
await waitFor(`Number.parseFloat(document.querySelector('.ai-resizer + div').style.width) === 640`)
await dragLayout('.ai-resizer', 10_000, 0)
await waitFor(`Number.parseFloat(document.querySelector('.ai-resizer + div').style.width) === 300`)
await dragLayout('.resize-handle.horizontal', 0, -10_000)
await waitFor(`Math.abs(Number.parseFloat(document.querySelector('.bottom-panel').style.height) - innerHeight * 0.6) < 1`)
await dragLayout('.resize-handle.horizontal', 0, 10_000)
await waitFor(`Number.parseFloat(document.querySelector('.bottom-panel').style.height) === 140`)
const finalLayout = await evaluate(`return {
  sidebar: Number.parseFloat(document.querySelector('.primary-sidebar').style.width),
  ai: Number.parseFloat(document.querySelector('.ai-resizer + div').style.width),
  panel: Number.parseFloat(document.querySelector('.bottom-panel').style.height),
  panelLimit: innerHeight * 0.6
}`)
if (finalLayout.sidebar !== 200 || finalLayout.ai !== 300 || finalLayout.panel !== 140) {
  throw new Error(`Panel resize bounds failed: ${JSON.stringify(finalLayout)}`)
}
for (const [title, missingExpression] of [
  ['Primary sidebar', `!document.querySelector('.primary-sidebar')`],
  ['Bottom panel', `document.querySelector('.bottom-panel')?.style.display === 'none'`],
  ['AI sidebar', `!document.querySelector('.ai-resizer')`]
]) {
  await evaluate(`document.querySelector('button[title=${JSON.stringify(title)}]').click(); return true`)
  await waitFor(missingExpression)
  await evaluate(`document.querySelector('button[title=${JSON.stringify(title)}]').click(); return true`)
}

// Terminal accelerator must toggle the actual terminal panel.
await macShortcut('`')
await waitFor(`document.querySelector('.bottom-panel')?.style.display === 'none'`)
await macShortcut('`')
await waitFor(`document.querySelector('.bottom-panel')?.style.display !== 'none' && [...document.querySelectorAll('.panel-tabs button')].find((item) => item.textContent.includes('terminal'))?.classList.contains('active')`)

await evaluate(`await window.omnicode.workspace.trashEntry(${JSON.stringify(auditRoot)}); return true`)
await waitFor(`${JSON.stringify(Object.values(names))}.every((name) => !document.querySelector('.editor-tabs button[title$="/' + name + '"]'))`)
if (await fs.stat(auditRoot).then(() => true, () => false)) throw new Error(`Audit directory was not removed: ${auditRoot}`)

const unexpectedErrors = runtimeErrors.filter((message) => !/ResizeObserver loop|Failed to load resource.*(?:403|404)/iu.test(message))
if (unexpectedErrors.length) throw new Error(`Renderer errors: ${unexpectedErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify({
  shortcuts: { quickOpen: true, commandPalette: true, workspaceSearch: true, closeTab: true, undo: true, redo: true, save: true, find: true, settings: true, terminal: true, inlineAI: true },
  editor: { multipleTabs, autoIndent: true, languageDetection: 'TypeScript', ...editorRendering },
  workspaceReplaceAll: true,
  themes,
  focusAndDisabled,
  layout: finalLayout,
  cleanup: true,
  runtimeErrors: unexpectedErrors
}, null, 2))
