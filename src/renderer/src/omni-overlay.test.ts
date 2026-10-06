import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Overlay, overlayVoiceEventSession } from './omni-overlay'

describe('global Omni voice overlay', () => {
  it('renders the compact voice surface without dashboard or typed-input controls', () => {
    const html = renderToStaticMarkup(createElement(Overlay))

    expect(html).toContain('Omni')
    expect(html).toContain('Ready')
    expect(html).toContain('omni-wave')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('Course of Action')
    expect(html).not.toContain('Activity')
    expect(html).not.toContain('Provider')
  })

  it('adopts early voice events while an AirPods session is still starting', () => {
    expect(overlayVoiceEventSession('session-a', null, null, true)).toEqual({ accept: true, adopt: true })
    expect(overlayVoiceEventSession('session-a', 'session-a', 'session-a', false)).toEqual({ accept: true, adopt: false })
    expect(overlayVoiceEventSession('stale', 'session-a', 'session-a', false)).toEqual({ accept: false, adopt: false })
  })
})
