import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function apple(...expressions) {
  const args = expressions.flatMap((expression) => ['-e', expression])
  return (await execFileAsync('/usr/bin/osascript', args, { timeout: 5_000 })).stdout.trim()
}
async function waitFor(check, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

await apple('tell application "OmniCode" to activate')
await waitFor(
  async () => (await apple('tell application "System Events" to tell process "OmniCode" to get frontmost')) === 'true',
  'OmniCode to become frontmost'
)

const expected = {
  OmniCode: ['About OmniCode', 'Settings…', 'Setup & Install Tools…', 'Services', 'Hide OmniCode', 'Quit OmniCode'],
  File: ['Open…', 'Open Folder…', 'Save', 'Save As…', 'Close Editor'],
  Edit: ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Delete', 'Select All', 'Find', 'Find in Workspace'],
  Selection: ['Select All', 'Expand Selection', 'Shrink Selection'],
  View: ['Command Palette…', 'Quick Open…', 'Toggle Primary Sidebar', 'Toggle Bottom Panel', 'Toggle AI Sidebar', 'Toggle Full Screen'],
  Go: ['Go to File…', 'Go to Line…'],
  Run: ['Run Current File', 'Start Local Server', 'Restart Local Server', 'Stop Local Server'],
  Terminal: ['New Terminal', 'Toggle Terminal', 'Clear Terminal', 'Kill Active Terminal'],
  AI: ['Open AI Chat', 'Inline Edit…', 'Index Workspace', 'AI Provider Settings…'],
  Window: ['Minimize', 'Zoom', 'Bring All to Front'],
  Help: ['Welcome & Keyboard Shortcuts']
}

const topLevel = (await apple('tell application "System Events" to tell process "OmniCode" to get name of every menu bar item of menu bar 1')).split(', ')
for (const menuName of Object.keys(expected)) {
  if (!topLevel.includes(menuName)) throw new Error(`Missing native menu: ${menuName}`)
}

const observed = {}
const normalizeLabel = (value) => value.replaceAll('&', '').replace(/\s+/gu, ' ').trim()
for (const [menuName, expectedItems] of Object.entries(expected)) {
  const raw = await apple(
    `tell application "System Events" to tell process "OmniCode" to click menu bar item ${JSON.stringify(menuName)} of menu bar 1`,
    `tell application "System Events" to tell process "OmniCode" to get name of every menu item of menu 1 of menu bar item ${JSON.stringify(menuName)} of menu bar 1`
  )
  const items = raw.split(', ').filter((item) => item && item !== 'missing value')
  observed[menuName] = items
  for (const item of expectedItems) {
    if (!items.some((observedItem) => normalizeLabel(observedItem) === normalizeLabel(item))) {
      throw new Error(`${menuName} is missing native item ${item}. Observed: ${items.join(', ')}`)
    }
  }
  await apple('tell application "System Events" to key code 53')
}

// Invoke a representative renderer-bound command twice from the actual native menu,
// returning the workbench to its starting visibility state.
for (let index = 0; index < 2; index += 1) {
  await apple(
    'tell application "System Events" to tell process "OmniCode" to click menu bar item "View" of menu bar 1',
    'tell application "System Events" to tell process "OmniCode" to click menu item "Toggle Primary Sidebar" of menu 1 of menu bar item "View" of menu bar 1'
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
}

console.log(JSON.stringify({
  topLevel,
  menusOpened: Object.keys(observed),
  expectedItemsVerified: Object.values(expected).reduce((total, items) => total + items.length, 0),
  representativeCommandInvoked: 'Toggle Primary Sidebar (twice)'
}, null, 2))
