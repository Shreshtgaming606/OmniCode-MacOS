import { describe, expect, it } from 'vitest'

import {
  createOmniLoginItemSettings,
  OMNI_BACKGROUND_LAUNCH_ARGUMENT,
  shouldApplyOmniLoginItemSettings,
  shouldStartOmniInBackground
} from './omni-background-launch'

describe('Omni background launch policy', () => {
  it('never hides a development launch, even when the internal argument is present', () => {
    expect(shouldStartOmniInBackground({
      argumentsList: ['electron', '.', OMNI_BACKGROUND_LAUNCH_ARGUMENT],
      isPackaged: false,
      wasOpenedAtLogin: true
    })).toBe(false)
  })

  it('recognizes only the exact background argument in packaged builds', () => {
    expect(shouldStartOmniInBackground({
      argumentsList: ['/Applications/OmniCode.app/Contents/MacOS/OmniCode', OMNI_BACKGROUND_LAUNCH_ARGUMENT],
      isPackaged: true
    })).toBe(true)
    expect(shouldStartOmniInBackground({
      argumentsList: ['/Applications/OmniCode.app/Contents/MacOS/OmniCode', `${OMNI_BACKGROUND_LAUNCH_ARGUMENT}=true`],
      isPackaged: true
    })).toBe(false)
  })

  it('recognizes a real macOS login-item launch without relying on custom arguments', () => {
    expect(shouldStartOmniInBackground({
      argumentsList: ['/Applications/OmniCode.app/Contents/MacOS/OmniCode'],
      isPackaged: true,
      wasOpenedAtLogin: true
    })).toBe(true)
  })

  it('adds and removes the private launch argument together with the login item', () => {
    expect(createOmniLoginItemSettings(true, true)).toEqual({
      openAtLogin: true,
      args: [OMNI_BACKGROUND_LAUNCH_ARGUMENT]
    })
    expect(createOmniLoginItemSettings(false, true)).toEqual({ openAtLogin: false, args: [] })
    expect(createOmniLoginItemSettings(true, false)).toEqual({ openAtLogin: false, args: [] })
  })

  it('does not rewrite an already-matching macOS login-item state', () => {
    expect(shouldApplyOmniLoginItemSettings(false, createOmniLoginItemSettings(false, false))).toBe(false)
    expect(shouldApplyOmniLoginItemSettings(false, createOmniLoginItemSettings(true, true))).toBe(true)
    expect(shouldApplyOmniLoginItemSettings(true, createOmniLoginItemSettings(true, true))).toBe(false)
    expect(shouldApplyOmniLoginItemSettings(true, createOmniLoginItemSettings(false, false))).toBe(true)
  })
})
