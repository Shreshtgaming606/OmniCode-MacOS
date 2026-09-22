import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  displayedOmniApprovalMode,
  humanizeOmniError,
  humanizeOmniStatus,
  isTerminalOmniStatus,
  OmniMode
} from './OmniMode'

describe('OmniMode', () => {
  it('renders an honest typed fallback without claiming unfinished native capabilities', () => {
    const html = renderToStaticMarkup(createElement(OmniMode, { active: true }))

    expect(html).toContain('Typed request')
    expect(html).toContain('Voice input unavailable')
    expect(html).toContain('Native cursor unavailable')
    expect(html).toContain('Connecting to the Omni controller')
    expect(html).not.toContain('Voice ready')
    expect(html).not.toContain('Cursor ready')
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
})
