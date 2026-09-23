import { describe, expect, it } from 'vitest'

import { isOmniOverlayInvokeChannel } from './omni-overlay-channel-policy'

describe('Omni overlay invoke-channel policy', () => {
  it.each([
    'omni:overlay:settings',
    'omni:overlay:start',
    'omni:overlay:permissions-status',
    'omni:overlay:permissions-request',
    'omni:overlay:permissions-open-settings',
    'omni:overlay:voice-input-availability',
    'omni:overlay:voice-start-input',
    'omni:overlay:voice-stop-input',
    'omni:overlay:voice-cancel-input',
    'omni:overlay:voice-stop'
  ])('allows the restricted overlay channel %s', (channel) => {
    expect(isOmniOverlayInvokeChannel(channel)).toBe(true)
  })

  it.each([
    'workspace:read-tree',
    'terminal:create',
    'ai:save-credential',
    'work:tools:execute',
    'omni:permissions:status'
  ])('continues to reject the privileged channel %s', (channel) => {
    expect(isOmniOverlayInvokeChannel(channel)).toBe(false)
  })
})

