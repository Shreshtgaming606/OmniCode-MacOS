const OMNI_OVERLAY_INVOKE_CHANNELS = new Set([
  'omni:overlay:settings',
  'omni:overlay:start',
  'omni:overlay:pause',
  'omni:overlay:resume',
  'omni:overlay:stop',
  'omni:overlay:get',
  'omni:overlay:list',
  'omni:overlay:hide',
  'omni:overlay:open-main',
  'omni:overlay:permissions-status',
  'omni:overlay:permissions-request',
  'omni:overlay:permissions-open-settings',
  'omni:overlay:voice-input-availability',
  'omni:overlay:voice-start-input',
  'omni:overlay:voice-stop-input',
  'omni:overlay:voice-cancel-input',
  'omni:overlay:voice-stop'
])

export function isOmniOverlayInvokeChannel(channel: string): boolean {
  return OMNI_OVERLAY_INVOKE_CHANNELS.has(channel)
}

