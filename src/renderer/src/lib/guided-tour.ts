import type { AppMode } from '../../../shared/work-contracts'

export const TOUR_VERSION = 1
export const TOUR_STORAGE_KEY = 'omnicode.guidedTour'

export type TourOutcome = 'completed' | 'skipped'

export interface TourStep {
  id: string
  title: string
  description: string
  selector: string
  mode?: AppMode
  settingsSection?: string
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'navigation', title: 'Everything starts here', description: 'Switch between Code, Work, and Omni. Notifications and settings stay close by.', selector: '.mode-switcher' },
  { id: 'code', title: 'Code Mode', description: 'Edit projects, run commands, fix code, and test builds with an AI-powered development workspace.', selector: '.mode-switcher button[title="Software development workspace"]', mode: 'code' },
  { id: 'work', title: 'Work Mode', description: 'Search Gmail, work with Google Drive, browse with the Managed Browser, and complete tasks in one conversation.', selector: '.mode-switcher button[title="AI work assistant"]', mode: 'work' },
  { id: 'omni', title: 'Meet Omni', description: 'Press ⌘⇧Space and speak naturally. Omni can use tools, files, connected apps, Invisible Mode, and Cursor Mode when enabled.', selector: '.mode-switcher button[title="Voice-first system assistant"]', mode: 'omni' },
  { id: 'providers', title: 'Choose how OmniCode thinks', description: 'Use local Ollama models or connect OpenAI, Claude, and Gemini. Local AI needs no cloud account.', selector: '#providers h2', settingsSection: 'providers' },
  { id: 'connected-apps', title: 'Connected Apps', description: 'Connect Gmail and Google Drive. OmniCode keeps access and tool permissions under your control.', selector: '#connected-apps h2', settingsSection: 'connected-apps' },
  { id: 'activity', title: 'Follow the work', description: 'Live activity shows actions such as reading files, running tests, or searching Gmail—not private AI reasoning.', selector: '.ai-sidebar .ai-header', mode: 'code' },
  { id: 'notifications', title: 'Notification Center', description: 'Completed tasks, failures, builds, and background outcomes appear here. The badge shows unread items.', selector: '.notification-bell' },
  { id: 'settings', title: "You're ready", description: 'Customize AI, voice, privacy, notifications, integrations, and Omni behavior in Settings.', selector: '.settings-panel > header h1', settingsSection: 'appearance' }
]

export function readTourOutcome(storage: Pick<Storage, 'getItem'>): TourOutcome | null {
  try {
    const stored = JSON.parse(storage.getItem(TOUR_STORAGE_KEY) ?? 'null') as unknown
    if (!stored || typeof stored !== 'object') return null
    const value = stored as { version?: unknown; outcome?: unknown }
    return value.version === TOUR_VERSION && (value.outcome === 'completed' || value.outcome === 'skipped') ? value.outcome : null
  } catch { return null }
}

export function saveTourOutcome(storage: Pick<Storage, 'setItem'>, outcome: TourOutcome): void {
  storage.setItem(TOUR_STORAGE_KEY, JSON.stringify({ version: TOUR_VERSION, outcome }))
}

export function shouldOfferTour(storage: Pick<Storage, 'getItem'>): boolean {
  return storage.getItem('omnicode.onboardingComplete') !== 'true' && readTourOutcome(storage) === null
}

export function nextTourIndex(index: number, direction: -1 | 1, length = TOUR_STEPS.length): number {
  return Math.max(0, Math.min(length - 1, index + direction))
}
