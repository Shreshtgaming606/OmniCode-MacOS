import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from './tool-registry'
import { registerModernMacOSTools } from './modern-macos-tools'
import type { ModernMacOSService } from './modern-macos-service'

function setup() {
  const translate = vi.fn(async () => ({ text: 'Hola mundo.', engine: 'Apple Translation · on-device' }))
  const recognizeWorkspaceImage = vi.fn(async () => ({ text: 'HELLO', lineCount: 1, engine: 'Apple Vision · on-device' }))
  const capture = vi.fn(async () => ({ text: 'OmniCode', lineCount: 1, engine: 'Apple Vision · on-device' }))
  const service = { translate, recognizeWorkspaceImage } as unknown as ModernMacOSService
  const code = new ToolRegistry()
  const work = new ToolRegistry()
  const omni = new ToolRegistry()
  registerModernMacOSTools(service, code, work, omni, () => '/workspace', capture)
  return { code, work, omni, translate, recognizeWorkspaceImage, capture }
}

const authorization = (confirm = vi.fn(async () => true)) => ({
  accessLevel: 'trusted' as const, approvalMode: 'full' as const, confirm
})

describe('modern native tools', () => {
  it('uses the same local translation service in Code and Work without an extra approval', async () => {
    const { code, work, translate } = setup()
    for (const [registry, mode] of [[code, 'code'], [work, 'work']] as const) {
      const confirm = vi.fn(async () => true)
      const response = await registry.execute({ toolId: 'system.translate', mode, input: { text: 'Hello world.', source: 'en', target: 'es' } }, authorization(confirm))
      expect(response.result).toMatchObject({ text: 'Hola mundo.', engine: 'Apple Translation · on-device' })
      expect(confirm).not.toHaveBeenCalled()
    }
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('scopes image text to the active Code workspace', async () => {
    const { code, recognizeWorkspaceImage } = setup()
    await code.execute({ toolId: 'system.read-image-text', mode: 'code', input: { imagePath: '/workspace/fixture.png' } }, authorization())
    expect(recognizeWorkspaceImage).toHaveBeenCalledWith('/workspace/fixture.png', '/workspace', expect.any(AbortSignal))
  })

  it('requires direct approval before window text reaches Omni model context', async () => {
    const { omni, capture } = setup()
    const confirm = vi.fn(async () => false)
    await expect(omni.execute({ toolId: 'system.read-omnicode-window', mode: 'omni', input: {} }, authorization(confirm))).rejects.toThrow()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(capture).not.toHaveBeenCalled()
  })
})
