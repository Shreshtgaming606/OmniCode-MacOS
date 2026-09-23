import type {
  OmniPermissionCategory,
  OmniPermissionDetail,
  OmniPermissionId,
  OmniPermissionsSnapshot,
  OmniPermissionState,
  OmniSpeechInputAvailability
} from '../../shared/omni-contracts'

const PERMISSION_IDS: OmniPermissionId[] = [
  'microphone',
  'speech-recognition',
  'accessibility',
  'screen-recording',
  'notifications',
  'automation',
  'files-and-folders',
  'launch-at-login'
]

const COPY: Record<OmniPermissionId, {
  category: OmniPermissionCategory
  label: string
  explanation: string
}> = {
  microphone: {
    category: 'core',
    label: 'Microphone',
    explanation: 'Allows Omni to hear you only while a voice interaction is active.'
  },
  'speech-recognition': {
    category: 'core',
    label: 'Speech Recognition',
    explanation: 'Allows Apple Speech Recognition to turn your spoken request into text.'
  },
  accessibility: {
    category: 'computer-control',
    label: 'Accessibility',
    explanation: 'Allows Cursor Mode to interact with supported buttons, menus, and fields.'
  },
  'screen-recording': {
    category: 'computer-control',
    label: 'Screen Recording',
    explanation: 'Allows Omni to inspect visible application content only when an active task needs it.'
  },
  notifications: {
    category: 'optional',
    label: 'Notifications',
    explanation: 'Allows Omni to tell you when a background task finishes or needs attention.'
  },
  automation: {
    category: 'scoped',
    label: 'App Automation',
    explanation: 'macOS grants Apple Events access separately for each application when Omni first controls it.'
  },
  'files-and-folders': {
    category: 'scoped',
    label: 'Files & Folders',
    explanation: 'Omni uses folders you explicitly choose; it does not request Full Disk Access.'
  },
  'launch-at-login': {
    category: 'optional',
    label: 'Launch at Login',
    explanation: 'Keeps the global Omni shortcut available after you sign in to your Mac.'
  }
}

export interface MacOSPermissionDependencies {
  platform: NodeJS.Platform
  mediaStatus(kind: 'microphone' | 'screen'): OmniPermissionState
  requestMicrophone(): Promise<boolean>
  accessibilityTrusted(prompt: boolean): boolean
  requestScreenCapture(): Promise<boolean>
  speechStatus(): Promise<OmniSpeechInputAvailability>
  requestSpeechRecognition(): Promise<OmniPermissionState>
  notificationsSupported(): boolean
  requestNotification(): Promise<boolean>
  launchAtLoginEnabled(): boolean
  setLaunchAtLogin(enabled: boolean): void
  openExternal(url: string): Promise<void>
  now(): number
}

const SETTINGS_URLS: Record<OmniPermissionId, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  'speech-recognition': 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  'files-and-folders': 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  'launch-at-login': 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
}

function normalized(value: OmniPermissionState): OmniPermissionState {
  return value === 'granted' || value === 'denied' || value === 'not-determined' || value === 'requesting' ||
    value === 'restricted' || value === 'unavailable' || value === 'requires-settings' || value === 'requires-restart'
    ? value
    : 'unavailable'
}

export class MacOSPermissionManager {
  readonly #attempted = new Set<OmniPermissionId>()
  readonly #listeners = new Set<(snapshot: OmniPermissionsSnapshot) => void>()
  #notificationVerified = false
  #settingsOpen = false

  constructor(private readonly dependencies: MacOSPermissionDependencies) {}

  async snapshot(): Promise<OmniPermissionsSnapshot> {
    const details = {} as Record<OmniPermissionId, OmniPermissionDetail>
    if (this.dependencies.platform !== 'darwin') {
      for (const id of PERMISSION_IDS) details[id] = this.#detail(id, 'unavailable', false, 'This capability currently requires macOS.')
      return this.#snapshot(details)
    }

    const speech = await this.dependencies.speechStatus().catch(() => null)
    const microphone = normalized(speech?.microphonePermission ?? this.dependencies.mediaStatus('microphone'))
    const speechRecognition = normalized(speech?.speechRecognitionPermission ?? 'unavailable')
    const accessibility = this.dependencies.accessibilityTrusted(false)
      ? 'granted'
      : this.#attempted.has('accessibility') ? 'requires-settings' : 'not-determined'
    const screenRaw = normalized(this.dependencies.mediaStatus('screen'))
    const screen = screenRaw === 'denied' && this.#attempted.has('screen-recording') ? 'requires-settings' : screenRaw
    const notifications = !this.dependencies.notificationsSupported()
      ? 'unavailable'
      : this.#notificationVerified ? 'granted' : this.#attempted.has('notifications') ? 'requires-settings' : 'not-determined'

    details.microphone = this.#detail('microphone', microphone, microphone === 'not-determined')
    details['speech-recognition'] = this.#detail(
      'speech-recognition',
      speechRecognition,
      speechRecognition === 'not-determined',
      speech && !speech.onDevice ? speech.reason ?? 'On-device recognition is unavailable for the selected locale.' : undefined,
      speech?.onDevice ?? false
    )
    details.accessibility = this.#detail('accessibility', accessibility, accessibility !== 'granted')
    details['screen-recording'] = this.#detail('screen-recording', screen, screen === 'not-determined')
    details.notifications = this.#detail('notifications', notifications, notifications !== 'granted')
    details.automation = this.#detail(
      'automation', 'not-determined', false,
      'Authorization is requested by macOS for each target app when an Apple Events action is used.'
    )
    details['files-and-folders'] = this.#detail(
      'files-and-folders', 'not-determined', false,
      'Access is granted per folder through the macOS folder picker; no global authorization is requested.'
    )
    details['launch-at-login'] = this.#detail(
      'launch-at-login', this.dependencies.launchAtLoginEnabled() ? 'granted' : 'not-determined', true
    )
    return this.#snapshot(details)
  }

  async request(id: OmniPermissionId): Promise<OmniPermissionDetail> {
    this.#assertId(id)
    if (this.dependencies.platform !== 'darwin') return this.#detail(id, 'unavailable', false, 'This capability currently requires macOS.')
    const attemptedBefore = this.#attempted.has(id)
    this.#attempted.add(id)
    switch (id) {
      case 'microphone': {
        const before = this.dependencies.mediaStatus('microphone')
        if (before === 'denied' || before === 'restricted') {
          await this.openSettings(id)
          break
        }
        await this.dependencies.requestMicrophone()
        break
      }
      case 'speech-recognition': {
        const before = (await this.dependencies.speechStatus().catch(() => null))?.speechRecognitionPermission
        if (before === 'denied' || before === 'restricted') await this.openSettings(id)
        else await this.dependencies.requestSpeechRecognition()
        break
      }
      case 'accessibility':
        if (!this.dependencies.accessibilityTrusted(true) && attemptedBefore) {
          // AX exposes only trusted/untrusted, not a distinct denied state.
          // The first explicit request uses Apple's prompt; a later explicit
          // retry routes directly to the pane where macOS requires the user to
          // enable a previously declined application.
          await this.openSettings(id)
        }
        break
      case 'screen-recording': {
        const before = this.dependencies.mediaStatus('screen')
        if (before === 'denied' || before === 'restricted') await this.openSettings(id)
        else await this.dependencies.requestScreenCapture()
        break
      }
      case 'notifications':
        this.#notificationVerified = await this.dependencies.requestNotification()
        if (!this.#notificationVerified) await this.openSettings(id)
        break
      case 'launch-at-login':
        this.dependencies.setLaunchAtLogin(true)
        break
      case 'automation':
      case 'files-and-folders':
        await this.openSettings(id)
        break
    }
    const refreshed = await this.refresh()
    return refreshed.details[id]
  }

  async revoke(id: OmniPermissionId): Promise<void> {
    this.#assertId(id)
    if (id === 'launch-at-login') {
      this.dependencies.setLaunchAtLogin(false)
      await this.refresh()
      return
    }
    await this.openSettings(id)
  }

  async openSettings(id: OmniPermissionId): Promise<void> {
    this.#assertId(id)
    this.#settingsOpen = true
    await this.dependencies.openExternal(SETTINGS_URLS[id])
  }

  async refreshAfterActivation(): Promise<OmniPermissionsSnapshot | null> {
    if (!this.#settingsOpen) return null
    this.#settingsOpen = false
    return await this.refresh()
  }

  async refresh(): Promise<OmniPermissionsSnapshot> {
    const value = await this.snapshot()
    for (const listener of this.#listeners) {
      try { listener(value) } catch { /* A renderer listener cannot break permission checks. */ }
    }
    return value
  }

  onChanged(listener: (snapshot: OmniPermissionsSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #snapshot(details: Record<OmniPermissionId, OmniPermissionDetail>): OmniPermissionsSnapshot {
    const permissions = {} as Record<OmniPermissionId, OmniPermissionState>
    for (const id of PERMISSION_IDS) permissions[id] = details[id].state
    return { checkedAt: this.dependencies.now(), permissions, details }
  }

  #detail(
    id: OmniPermissionId,
    state: OmniPermissionState,
    canRequest: boolean,
    featureReason?: string,
    featureAvailable = true
  ): OmniPermissionDetail {
    return {
      id,
      state,
      ...COPY[id],
      canRequest,
      canOpenSettings: this.dependencies.platform === 'darwin',
      featureAvailable,
      ...(featureReason ? { featureReason } : {})
    }
  }

  #assertId(id: OmniPermissionId): void {
    if (!PERMISSION_IDS.includes(id)) throw new Error('Choose a supported macOS permission.')
  }
}

export { PERMISSION_IDS }
