import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  displayedOmniApprovalMode,
  humanizeOmniError,
  humanizeOmniStatus,
  isTerminalOmniStatus,
  presentOmniError,
  OmniMode
} from './OmniMode'

describe('OmniMode', () => {
  it('renders an honest controller-loading state before persisted setup is known', () => {
    const html = renderToStaticMarkup(createElement(OmniMode, { active: true }))

    expect(html).toContain('Starting Omni')
    expect(html).toContain('Connecting to the Omni controller')
    expect(html).not.toContain('Course of action')
    expect(html).not.toContain('Typed request')
  })

  it('classifies only finished task states as terminal', () => {
    expect(isTerminalOmniStatus('completed')).toBe(true)
    expect(isTerminalOmniStatus('failed')).toBe(true)
    expect(isTerminalOmniStatus('stopped')).toBe(true)
    expect(isTerminalOmniStatus('paused')).toBe(false)
    expect(isTerminalOmniStatus('waiting-for-approval')).toBe(false)
  })

  it('keeps an active task bound to the approval mode it actually started with', () => {
    expect(displayedOmniApprovalMode('full', { status: 'working', approvalMode: 'ask' })).toBe('ask')
    expect(displayedOmniApprovalMode('full', { status: 'completed', approvalMode: 'ask' })).toBe('full')
  })

  it('turns controller state identifiers into readable labels', () => {
    expect(humanizeOmniStatus('using-cursor')).toBe('Using Cursor')
    expect(humanizeOmniStatus('waiting-for-approval')).toBe('Waiting For Approval')
  })

  it('removes Electron IPC wrapper noise from bounded UI errors', () => {
    expect(humanizeOmniError(
      new Error("Error invoking remote method 'omni:task:start': Error: No model is configured.")
    )).toBe('No model is configured.')
    expect(humanizeOmniError(new Error('Authorization failed for Bearer secret-token-value')))
      .toBe('Authorization failed for Bearer [REDACTED]')
    expect(humanizeOmniError(new Error('x'.repeat(2_000)))).toHaveLength(1_000)
  })

  it('turns raw provider failures into calm actionable UI copy', () => {
    expect(presentOmniError(new Error('AI provider returned 503: {"error":"high demand"}'))).toMatchObject({
      title: 'AI provider unavailable',
      message: 'The selected model is temporarily busy. Try again or choose another model.'
    })
    expect(presentOmniError(new Error('429 quota exceeded')).title).toBe('Provider limit reached')
  })
})
