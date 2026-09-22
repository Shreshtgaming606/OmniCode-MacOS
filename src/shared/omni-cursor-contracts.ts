/**
 * Structured Cursor Mode contracts. These intentionally expose a small,
 * closed command surface instead of accepting AppleScript, shell commands,
 * JavaScript, accessibility selectors, or arbitrary native payloads.
 */

export type OmniCursorButton = 'left' | 'right'

export type OmniCursorModifier = 'command' | 'control' | 'option' | 'shift' | 'function'

export type OmniCursorNamedKey =
  | 'return'
  | 'escape'
  | 'tab'
  | 'space'
  | 'delete'
  | 'forward-delete'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'page-up'
  | 'page-down'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12'

/** Single ASCII letters/digits are accepted in addition to named keys. */
export type OmniCursorKey = OmniCursorNamedKey | string

export type OmniCursorApplicationId =
  | 'omnicode'
  | 'finder'
  | 'safari'
  | 'chrome'
  | 'mail'
  | 'calendar'
  | 'notes'
  | 'terminal'
  | 'xcode'
  | 'simulator'
  | 'preview'
  | 'textedit'

export interface OmniCursorPoint {
  x: number
  y: number
}

export interface OmniCursorFrontmostApplication {
  name: string | null
  bundleIdentifier: string | null
  processIdentifier: number
}

export interface OmniCursorObservation {
  cursor: OmniCursorPoint
  frontmostApplication: OmniCursorFrontmostApplication | null
  observedAt: number
}

export interface OmniCursorPermissionStatus {
  accessibility: 'granted' | 'denied' | 'unavailable'
  nativeHelper: 'available' | 'missing' | 'unavailable'
  checkedAt: number
}

export const OMNI_CURSOR_EMERGENCY_STOP_SHORTCUT = 'CommandOrControl+Shift+Escape'
export const OMNI_CURSOR_EMERGENCY_STOP_LABEL = '⌘⇧Esc'

export interface OmniCursorRuntimeStatus extends OmniCursorPermissionStatus {
  emergencyStop: 'registered' | 'unavailable'
  emergencyStopShortcut: typeof OMNI_CURSOR_EMERGENCY_STOP_SHORTCUT
}

export interface OmniCursorMoveRequest extends OmniCursorPoint {
  /** 0 is immediate; positive values provide bounded, visible movement. */
  durationMs?: number
}

export interface OmniCursorClickRequest {
  button?: OmniCursorButton
}

export interface OmniCursorScrollRequest {
  /** Positive horizontal values scroll toward content on the right. */
  deltaX?: number
  /** Positive vertical values scroll toward content below. */
  deltaY: number
}

export interface OmniCursorPressKeyRequest {
  key: OmniCursorKey
  modifiers?: OmniCursorModifier[]
  repeat?: number
}

export interface OmniCursorActionResult {
  observation: OmniCursorObservation
}

export type OmniCursorSessionState = 'active' | 'user-takeover' | 'stopped'

export interface OmniCursorUserTakeoverEvent {
  reason: 'pointer-moved' | 'native-detection'
  observedAt: number
  previousCursor: OmniCursorPoint
  currentCursor: OmniCursorPoint
}

export const OMNI_CURSOR_LIMITS = {
  coordinateMagnitude: 100_000,
  movementDurationMs: 1_000,
  scrollDelta: 2_000,
  textCharacters: 8_192,
  keyRepeats: 20,
  takeoverPollIntervalMs: 125,
  takeoverTolerancePixels: 12,
  helperRequestBytes: 64 * 1_024,
  helperResponseBytes: 256 * 1_024,
  helperTimeoutMs: 15_000
} as const
