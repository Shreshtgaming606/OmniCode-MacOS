import { describe, expect, it, vi } from 'vitest'

import { MacOSPermissionManager, type MacOSPermissionDependencies } from './macos-permission-manager'

function dependencies(overrides: Partial<MacOSPermissionDependencies> = {}): MacOSPermissionDependencies {
  return {
    platform: 'darwin',
    mediaStatus: () => 'not-determined',
    requestMicrophone: vi.fn(async () => true),
    accessibilityTrusted: vi.fn(() => false),
    requestScreenCapture: vi.fn(async () => true),
    speechStatus: vi.fn(async () => ({
      available: true,
      providerId: 'macos-speech',
      microphonePermission: 'not-determined' as const,
      speechRecognitionPermission: 'not-determined' as const,
      onDevice: true,
      streaming: true,
      locale: 'en-US',
      supportedLocales: ['en-US']
    })),
    requestSpeechRecognition: vi.fn(async () => 'granted' as const),
    notificationsSupported: () => true,
    requestNotification: vi.fn(async () => true),
    launchAtLoginEnabled: () => false,
    setLaunchAtLogin: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    now: () => 42,
    ...overrides
  }
}

describe('MacOSPermissionManager', () => {
  it('reports authorization separately from speech feature availability', async () => {
    const manager = new MacOSPermissionManager(dependencies({
      speechStatus: async () => ({
        available: false,
        reason: 'On-device Speech Recognition is unavailable for this locale.',
        providerId: 'macos-speech',
        microphonePermission: 'granted',
        speechRecognitionPermission: 'granted',
        onDevice: false,
        streaming: true,
        locale: 'en-US',
        supportedLocales: ['en-US']
      })
    }))

    const snapshot = await manager.snapshot()
    expect(snapshot.permissions['speech-recognition']).toBe('granted')
    expect(snapshot.details['speech-recognition']).toMatchObject({ featureAvailable: false })
  })

  it('requests microphone authorization and refreshes the real state', async () => {
    let state: 'not-determined' | 'granted' = 'not-determined'
    const requestMicrophone = vi.fn(async () => { state = 'granted'; return true })
    const manager = new MacOSPermissionManager(dependencies({
      mediaStatus: (kind) => kind === 'microphone' ? state : 'not-determined',
      requestMicrophone,
      speechStatus: async () => ({
        available: state === 'granted', providerId: 'macos-speech', microphonePermission: state,
        speechRecognitionPermission: 'not-determined', onDevice: true, streaming: true,
        locale: 'en-US', supportedLocales: ['en-US']
      })
    }))

    await expect(manager.request('microphone')).resolves.toMatchObject({ state: 'granted' })
    expect(requestMicrophone).toHaveBeenCalledOnce()
  })

  it('opens the exact Settings pane when a denied permission cannot re-prompt', async () => {
    const openExternal = vi.fn(async () => undefined)
    const manager = new MacOSPermissionManager(dependencies({
      mediaStatus: () => 'denied',
      speechStatus: async () => ({
        available: false, providerId: 'macos-speech', microphonePermission: 'denied',
        speechRecognitionPermission: 'not-determined', onDevice: true, streaming: true,
        locale: 'en-US', supportedLocales: ['en-US']
      }),
      openExternal
    }))

    await manager.request('microphone')
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('Privacy_Microphone'))
  })

  it('uses the native Accessibility prompt once and opens Settings on an explicit retry', async () => {
    const openExternal = vi.fn(async () => undefined)
    const accessibilityTrusted = vi.fn(() => false)
    const manager = new MacOSPermissionManager(dependencies({ accessibilityTrusted, openExternal }))

    await manager.request('accessibility')
    expect(accessibilityTrusted).toHaveBeenCalledWith(true)
    expect(openExternal).not.toHaveBeenCalled()

    await manager.request('accessibility')
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('Privacy_Accessibility'))
  })

  it('refreshes once when the app returns from System Settings', async () => {
    const manager = new MacOSPermissionManager(dependencies())
    const changed = vi.fn()
    manager.onChanged(changed)
    await manager.openSettings('accessibility')
    await expect(manager.refreshAfterActivation()).resolves.not.toBeNull()
    await expect(manager.refreshAfterActivation()).resolves.toBeNull()
    expect(changed).toHaveBeenCalledOnce()
  })
})
