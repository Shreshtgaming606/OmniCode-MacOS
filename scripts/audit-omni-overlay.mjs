import { promises as fs } from 'node:fs'

const port = Number(process.argv[2] ?? 9351)
const screenshotPath = process.argv[3]

async function targetsWhenReady(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json`)
      .then((response) => response.json())
      .catch(() => [])
    const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && predicate(item))
    if (target) return target
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for the packaged Omni renderer target.')
}

async function connection(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const pending = new Map()
  const errors = []
  let sequence = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if (message.id) {
      const operation = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) operation?.reject(new Error(message.error.message))
      else operation?.resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params?.exceptionDetails?.text ?? 'Runtime exception')
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') errors.push(message.params.entry.text)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (body) => {
    const result = await call('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  await call('Runtime.enable')
  await call('Log.enable')
  await call('Page.enable')
  return { socket, call, evaluate, errors }
}

async function waitFor(evaluate, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`return Boolean(${expression})`).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

const mainTarget = await targetsWhenReady((target) => !target.url.includes('omni-overlay.html'))
const main = await connection(mainTarget)
await waitFor(main.evaluate, 'window.omnicode')
const original = await main.evaluate('return await window.omnicode.omni.settings.get()')

try {
  await main.evaluate(`return await window.omnicode.omni.settings.update({ enabled: true, setupCompleted: true })`)
  await main.evaluate('return await window.omnicode.omni.activation.showOverlay()')

  const overlayTarget = await targetsWhenReady((target) => target.url.includes('omni-overlay.html'))
  const overlay = await connection(overlayTarget)
  try {
    await waitFor(overlay.evaluate, 'document.querySelector(".omni-voice-overlay") && window.omniOverlay')
    await waitFor(overlay.evaluate, '!document.querySelector(".phase-idle")', 15_000)
    await waitFor(overlay.evaluate, `
      !document.querySelector('.phase-permission') ||
      Boolean(document.querySelector('.omni-voice-actions button.primary'))
    `, 15_000)
    const result = await overlay.evaluate(`
      const root = document.querySelector('.omni-voice-overlay')
      const text = root?.textContent ?? ''
      return {
        width: innerWidth,
        height: innerHeight,
        focused: document.hasFocus(),
        fullApiExposed: Boolean(window.omnicode),
        overlayApiExposed: Boolean(window.omniOverlay),
        textarea: Boolean(root?.querySelector('textarea')),
        input: Boolean(root?.querySelector('input')),
        waveformBars: root?.querySelectorAll('.wave-bars i').length ?? 0,
        closeButton: Boolean(root?.querySelector('[aria-label="Close Omni"]')),
        openFullButton: Boolean(root?.querySelector('[aria-label="Open full Omni"]')),
        phase: [...(root?.classList ?? [])].find((name) => name.startsWith('phase-')) ?? '',
        text,
        forbidden: ['Course of Action', 'Current Step', 'Activity', 'Provider', 'Execution', 'Approvals', 'History']
          .filter((label) => text.includes(label))
      }
    `)
    if (result.width < 280 || result.width > 340 || result.height < 200 || result.height > 300 ||
      result.fullApiExposed || !result.overlayApiExposed || result.textarea || result.input ||
      result.waveformBars !== 13 || !result.closeButton || !result.openFullButton || result.forbidden.length) {
      throw new Error(`Compact overlay audit failed: ${JSON.stringify(result)}`)
    }

    await overlay.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const reducedMotion = await overlay.evaluate(`return getComputedStyle(document.querySelector('.wave-bars i')).animationName`)
    if (reducedMotion !== 'none') throw new Error(`Reduce Motion was not honored: ${reducedMotion}`)
    const unexpectedErrors = overlay.errors.filter((message) => !/ResizeObserver loop/iu.test(message))
    if (unexpectedErrors.length) throw new Error(`Overlay renderer logged errors: ${unexpectedErrors.join(' | ')}`)

    if (screenshotPath) {
      const screenshot = await overlay.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    }

    await overlay.evaluate('return await window.omniOverlay.activation.hide()')
    console.log(JSON.stringify({ ...result, reducedMotion, screenshotPath, runtimeErrors: unexpectedErrors }, null, 2))
  } finally {
    overlay.socket.close()
  }
} finally {
  await main.evaluate(`return await window.omnicode.omni.settings.update({
    enabled: ${JSON.stringify(original.enabled)},
    setupCompleted: ${JSON.stringify(original.setupCompleted)}
  })`).catch(() => undefined)
  main.socket.close()
}
