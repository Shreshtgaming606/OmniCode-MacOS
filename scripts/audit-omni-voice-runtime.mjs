const port = Number(process.argv[2] ?? 9352)

async function targetWhenReady() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const target = await fetch(`http://127.0.0.1:${port}/json`)
      .then((response) => response.json())
      .then((targets) => targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && !item.url?.includes('omni-overlay.html')))
      .catch(() => undefined)
    if (target) return target
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`No OmniCode renderer appeared on port ${port}.`)
}

const target = await targetWhenReady()
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
function call(method, params = {}) {
  const id = ++sequence
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(body) {
  const response = await call('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

await call('Runtime.enable')
const result = await evaluate(`
  const [permissions, tts, input, voices, cursor, settings] = await Promise.all([
    window.omnicode.omni.permissions.status(),
    window.omnicode.omni.voice.availability(),
    window.omnicode.omni.voice.inputAvailability(),
    window.omnicode.omni.voice.voices(),
    window.omnicode.omni.cursor.status(),
    window.omnicode.omni.settings.get()
  ])
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const interruptedStartedAt = performance.now()
  const interruptedPromise = window.omnicode.omni.voice.test().then(() => 'resolved', (error) => String(error))
  await wait(180)
  const stopAccepted = await window.omnicode.omni.voice.stop()
  const interruptedOutcome = await Promise.race([interruptedPromise, wait(5000).then(() => 'timeout')])
  const interruptedMs = Math.round(performance.now() - interruptedStartedAt)
  await wait(150)
  const completedStartedAt = performance.now()
  const completedOutcome = await window.omnicode.omni.voice.test().then(() => 'resolved', (error) => String(error))
  const completedMs = Math.round(performance.now() - completedStartedAt)
  const idleStopAccepted = await window.omnicode.omni.voice.stop()
  return {
    permissions,
    tts,
    input,
    voices: { count: voices.length, sample: voices.slice(0, 5), configuredVoiceId: settings.voice.voiceId },
    cursor,
    speechOutput: { stopAccepted, interruptedOutcome, interruptedMs, completedOutcome, completedMs, idleStopAccepted }
  }
`)

if (!result.tts?.available) throw new Error(`macOS TTS was unavailable: ${JSON.stringify(result.tts)}`)
if (!result.voices?.count) throw new Error('No installed macOS voices were returned.')
if (!result.speechOutput.stopAccepted || result.speechOutput.interruptedOutcome !== 'resolved') {
  throw new Error(`TTS interruption failed: ${JSON.stringify(result.speechOutput)}`)
}
if (result.speechOutput.completedOutcome !== 'resolved') throw new Error(`TTS completion failed: ${JSON.stringify(result.speechOutput)}`)
socket.close()
console.log(JSON.stringify(result, null, 2))
