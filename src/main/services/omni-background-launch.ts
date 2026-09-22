export const OMNI_BACKGROUND_LAUNCH_ARGUMENT = '--omni-background'

export interface OmniBackgroundLaunchContext {
  argumentsList: readonly string[]
  isPackaged: boolean
  wasOpenedAtLogin?: boolean
}

export interface OmniLoginItemSettings {
  openAtLogin: boolean
  args: string[]
}

/**
 * Development launches must always remain visible. In a packaged build the
 * explicit argument supports helper/command-line launches, while
 * `wasOpenedAtLogin` covers macOS main-app login items (macOS does not pass the
 * custom `args` option supported by Electron on Windows).
 */
export function shouldStartOmniInBackground(context: OmniBackgroundLaunchContext): boolean {
  if (!context.isPackaged) return false
  return context.wasOpenedAtLogin === true || context.argumentsList.includes(OMNI_BACKGROUND_LAUNCH_ARGUMENT)
}

/**
 * Keep the argument attached for platforms/helper configurations that support
 * it. macOS startup detection additionally uses `wasOpenedAtLogin`.
 */
export function createOmniLoginItemSettings(enabled: boolean, launchHelperAtLogin: boolean): OmniLoginItemSettings {
  const openAtLogin = enabled && launchHelperAtLogin
  return {
    openAtLogin,
    args: openAtLogin ? [OMNI_BACKGROUND_LAUNCH_ARGUMENT] : []
  }
}
