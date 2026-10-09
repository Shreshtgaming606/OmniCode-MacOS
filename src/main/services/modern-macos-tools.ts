import type { ToolDescriptor } from '../../shared/tool-contracts'
import type { ToolRegistry } from './tool-registry'
import type { ModernMacOSService } from './modern-macos-service'

const translationSchema: ToolDescriptor['inputSchema'] = {
  type: 'object', properties: {
    text: { type: 'string', minLength: 1, maxLength: 60_000 },
    source: { type: 'string', minLength: 2, maxLength: 16, description: 'BCP-47 source language code, such as en.' },
    target: { type: 'string', minLength: 2, maxLength: 16, description: 'BCP-47 target language code, such as es.' }
  }, required: ['text', 'source', 'target'], additionalProperties: false
}

export function registerModernMacOSTools(
  service: ModernMacOSService,
  code: ToolRegistry,
  work: ToolRegistry,
  omniComputer: ToolRegistry,
  workspace: () => string | null,
  captureOwnWindow: (signal: AbortSignal) => Promise<{ text: string; lineCount: number; engine: string }>
): void {
  const translation = (mode: 'code' | 'work'): ToolDescriptor => ({
    id: 'system.translate', name: 'Translate on this Mac',
    description: 'Translate provided text with Apple Translation on this Mac; no AI provider receives the text for this tool.',
    connectorId: 'system-native', modes: [mode], action: 'read', category: 'read', risk: 'low',
    reversible: true, externalSideEffect: false, confirmation: 'never', requiredScopes: [],
    inputSchema: translationSchema, timeoutMs: 60_000, maxResultBytes: 128 * 1024
  })
  for (const [mode, registry] of [['code', code], ['work', work]] as const) {
    registry.register(translation(mode), async (input, context) =>
      service.translate(String(input.text), String(input.source), String(input.target), context.signal))
  }
  code.register({
    id: 'system.read-image-text', name: 'Read text in workspace image',
    description: 'Recognize text in an image inside the active workspace with on-device Apple Vision. No image is sent to an AI provider.',
    connectorId: 'system-native', modes: ['code'], action: 'read', category: 'read', risk: 'low',
    reversible: true, externalSideEffect: false, confirmation: 'never', requiredScopes: [],
    inputSchema: { type: 'object', properties: { imagePath: { type: 'string', minLength: 1, maxLength: 4_096 } }, required: ['imagePath'], additionalProperties: false },
    timeoutMs: 110_000, maxResultBytes: 128 * 1024
  }, async (input, context) => {
    const root = workspace()
    if (!root) throw new Error('Open a workspace before reading an image.')
    return service.recognizeWorkspaceImage(String(input.imagePath), root, context.signal)
  })
  omniComputer.register({
    id: 'system.read-omnicode-window', name: 'Read OmniCode window text',
    description: 'Capture only the OmniCode window with ScreenCaptureKit and recognize its text locally. The resulting text is shared with the selected AI model only after direct approval.',
    connectorId: 'system-native', modes: ['omni'], action: 'sensitive', category: 'sensitive-data', risk: 'high',
    reversible: false, externalSideEffect: false, confirmation: 'always', requiredScopes: ['macos.screen-recording'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 120_000, maxResultBytes: 128 * 1024
  }, async (_input, context) => captureOwnWindow(context.signal))
}
