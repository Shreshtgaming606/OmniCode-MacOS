import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helper = path.join(root, 'out/native/omnicode-modern-helper.app/Contents/MacOS/omnicode-modern-helper')
const directory = await fs.mkdtemp(path.join(tmpdir(), 'omnicode-native-audit-'))
const imagePath = path.join(directory, 'text.png')
const drawing = `
import AppKit
let image = NSImage(size: NSSize(width: 1000, height: 220))
image.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 1000, height: 220).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 68, weight: .bold), .foregroundColor: NSColor.black]
("OMNICODE NATIVE TEST" as NSString).draw(at: NSPoint(x: 28, y: 70), withAttributes: attributes)
image.unlockFocus()
guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("image generation failed") }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
`

function invoke(request) {
  const result = spawnSync(helper, [], { input: JSON.stringify(request), encoding: 'utf8', timeout: 120_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Native helper exited ${result.status}.`)
  const response = JSON.parse(result.stdout)
  if (!response.ok) throw new Error(response.error || 'Native operation failed.')
  return response.result
}

try {
  const translation = invoke({ command: 'translate', text: 'Hello world.', source: 'en', target: 'es' })
  if (translation.text !== 'Hola mundo.' || translation.engine !== 'Apple Translation · on-device') {
    throw new Error('On-device translation returned an unexpected result.')
  }
  console.log('PASS — Apple Translation processed a harmless sentence on this Mac.')
  const drawn = spawnSync('xcrun', ['swift', '-e', drawing, imagePath], { encoding: 'utf8', timeout: 60_000 })
  if (drawn.error || drawn.status !== 0) throw new Error(`Could not create disposable OCR fixture: ${String(drawn.stderr).slice(0, 2_000)}`)
  const recognition = invoke({ command: 'recognize-text', imagePath })
  if (!/OMNICODE NATIVE TEST/iu.test(recognition.text) || recognition.engine !== 'Apple Vision · on-device') {
    throw new Error('On-device Vision did not recognize the harmless fixture.')
  }
  console.log('PASS — macOS 15 Vision RecognizeTextRequest read disposable image text on this Mac.')
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
