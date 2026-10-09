import { describe, expect, it } from 'vitest'
import { parseOmniCodeDeepLink, routeForSpotlightIdentifier } from './omnicode-deep-links'

const workspace = 'b77f014a-4d75-46b1-8cef-6420dd4094fe'

describe('OmniCode deep links', () => {
  it('accepts only supported navigation routes', () => {
    expect(parseOmniCodeDeepLink(`omnicode://workspace/${workspace}`)).toEqual({ kind: 'workspace', id: workspace })
    expect(parseOmniCodeDeepLink('omnicode://conversation/work/chat_1')).toEqual({ kind: 'conversation', mode: 'work', id: 'chat_1' })
    expect(parseOmniCodeDeepLink('omnicode://mode/code')).toEqual({ kind: 'mode', mode: 'code' })
    expect(parseOmniCodeDeepLink('omnicode://action/open-workspace')).toEqual({ kind: 'action', action: 'open-workspace' })
    expect(parseOmniCodeDeepLink('omnicode://action/open-recent-workspace')).toEqual({ kind: 'action', action: 'open-recent-workspace' })
    expect(parseOmniCodeDeepLink('omnicode://action/translate-clipboard')).toEqual({ kind: 'action', action: 'translate-clipboard' })
    expect(routeForSpotlightIdentifier(`workspace:${workspace}`)).toEqual({ kind: 'workspace', id: workspace })
    expect(routeForSpotlightIdentifier('action:start-voice')).toEqual({ kind: 'action', action: 'start-voice' })
  })

  it.each([
    'omnicode://workspace/../mode/code', 'omnicode://workspace/%2e%2e',
    'omnicode://mode/code?command=rm', 'omnicode://mode/javascript:alert(1)',
    'omnicode://conversation/work/$(whoami)', 'omnicode://conversation/work/a%2fb',
    'omnicode://mode/code#fragment', 'omnicode://unknown/item',
    'omnicode://action/translate-clipboard?text=secret', 'omnicode://action/run-command',
    `omnicode://mode/${'x'.repeat(600)}`, 'javascript:alert(1)'
  ])('rejects an untrusted route: %s', (value) => {
    expect(parseOmniCodeDeepLink(value)).toBeNull()
  })
})
