import { app } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { MacOSPlatformSnapshot } from '../../shared/platform-contracts'

type NativeCommand =
  | { command: 'translate'; text: string; source: string; target: string }
  | { command: 'recognize-text'; imagePath: string }
  | { command: 'capture-window'; windowId: number; outputPath: string }

type NativeResult = { text?: string; lineCount?: number; engine?: string; path?: string; width?: number; height?: number; scope?: string; dynamicRange?: string }

export function nativeFeatureHelperPath(packaged: boolean, appPath: string, resourcesPath: string): string {
  const root = packaged ? path.join(resourcesPath, 'omni-native') : path.join(appPath, 'out', 'native')
  return path.join(root, 'omnicode-modern-helper.app', 'Contents', 'MacOS', 'omnicode-modern-helper')
}

export function assertNativeFeatureAllowed(snapshot: MacOSPlatformSnapshot, command: NativeCommand['command']): void {
  if (snapshot.release !== 'current' || !(Number.parseInt(snapshot.actualMacOS, 10) >= 15)) {
    throw new Error('This native feature requires Current OmniCode on macOS 15 or later.')
  }
  if (command === 'translate' && !snapshot.capabilities.nativeTranslation) throw new Error('Native Translation is unavailable.')
  if (command === 'recognize-text' && !snapshot.capabilities.nativeVisionOCR) throw new Error('Native Vision recognition is unavailable.')
  if (command === 'capture-window' && !snapshot.capabilities.windowCapture) throw new Error('Window capture is unavailable.')
}

export class ModernMacOSService {
  constructor(private readonly snapshot: () => MacOSPlatformSnapshot,
              private readonly helperPath = nativeFeatureHelperPath(app.isPackaged, app.getAppPath(), process.resourcesPath)) {}

  async translate(text: string, source: string, target: string, signal?: AbortSignal): Promise<{ text: string; engine: string }> {
    if (!text || Buffer.byteLength(text) > 100_000) throw new Error('Translate 1–100,000 bytes of text at a time.')
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u.test(source) || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u.test(target)) {
      throw new Error('Source and target must be valid language codes.')
    }
    const result = await this.invoke({ command: 'translate', text, source, target }, signal)
    if (typeof result.text !== 'string' || result.engine !== 'Apple Translation · on-device') throw new Error('Native Translation returned an invalid response.')
    return { text: result.text, engine: result.engine }
  }

  async recognizeWorkspaceImage(imagePath: string, workspaceRoot: string, signal?: AbortSignal): Promise<{ text: string; lineCount: number; engine: string }> {
    const realRoot = await fs.realpath(workspaceRoot)
    const realImage = await fs.realpath(imagePath)
    if (!realImage.startsWith(`${realRoot}${path.sep}`)) throw new Error('Image must be inside the active workspace.')
    if (!/\.(?:png|jpe?g|heic|tiff?|bmp)$/iu.test(realImage)) throw new Error('Select a supported image file.')
    const size = (await fs.stat(realImage)).size
    if (size > 20 * 1024 * 1024) throw new Error('Image exceeds the 20 MB local-recognition limit.')
    return await this.recognizeImage(realImage, signal)
  }

  async recognizeImage(imagePath: string, signal?: AbortSignal): Promise<{ text: string; lineCount: number; engine: string }> {
    const result = await this.invoke({ command: 'recognize-text', imagePath }, signal)
    if (typeof result.text !== 'string' || typeof result.lineCount !== 'number' || result.engine !== 'Apple Vision · on-device') {
      throw new Error('Native Vision returned an invalid response.')
    }
    return { text: result.text, lineCount: result.lineCount, engine: result.engine }
  }

  async captureOwnWindow(windowId: number, outputPath: string, signal?: AbortSignal): Promise<NativeResult> {
    if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error('OmniCode window identifier is invalid.')
    if (!path.isAbsolute(outputPath) || !outputPath.toLowerCase().endsWith('.png')) throw new Error('Choose a PNG output path.')
    const result = await this.invoke({ command: 'capture-window', windowId, outputPath }, signal)
    if (result.path !== outputPath || result.scope !== 'OmniCode window only') throw new Error('Window capture returned an invalid response.')
    return result
  }

  private async invoke(command: NativeCommand, signal?: AbortSignal): Promise<NativeResult> {
    assertNativeFeatureAllowed(this.snapshot(), command.command)
    return await new Promise<NativeResult>((resolve, reject) => {
      const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], signal })
      let stdout = ''
      const timeoutMs = command.command === 'recognize-text' ? 100_000 : 45_000
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
        if (stdout.length > 150_000) child.kill()
      })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', () => {
        clearTimeout(timer)
        try {
          const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string; result?: NativeResult }
          if (!parsed.ok || !parsed.result) throw new Error(parsed.error || 'The native macOS operation failed.')
          resolve(parsed.result)
        } catch (error) { reject(error) }
      })
      child.stdin.end(JSON.stringify(command))
    })
  }
}
