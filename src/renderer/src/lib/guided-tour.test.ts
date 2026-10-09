import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { GuidedTour } from '../components/tour/GuidedTour'
import { TOUR_STEPS, TOUR_STORAGE_KEY, TOUR_VERSION, nextTourIndex, readTourOutcome, saveTourOutcome, shouldOfferTour } from './guided-tour'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }
  }
}

describe('post-setup guided tour', () => {
  it('offers once after genuine first setup, then honors skip and completion across restarts', () => {
    const values = storage()
    expect(shouldOfferTour(values)).toBe(true)
    saveTourOutcome(values, 'skipped')
    expect(readTourOutcome(values)).toBe('skipped')
    expect(shouldOfferTour(values)).toBe(false)
    saveTourOutcome(values, 'completed')
    expect(readTourOutcome(values)).toBe('completed')
    const reopened = { getItem: values.getItem }
    expect(readTourOutcome(reopened)).toBe('completed')
    expect(shouldOfferTour(reopened)).toBe(false)
  })

  it('does not auto-offer to an existing user, and treats an older tour version as new', () => {
    const values = storage()
    values.setItem('omnicode.onboardingComplete', 'true')
    expect(shouldOfferTour(values)).toBe(false)
    values.setItem(TOUR_STORAGE_KEY, JSON.stringify({ version: TOUR_VERSION - 1, outcome: 'completed' }))
    expect(readTourOutcome(values)).toBeNull()
    expect(shouldOfferTour(values)).toBe(false)
  })

  it('includes nine real-interface steps for both release profiles and bounded keyboard navigation', () => {
    expect(TOUR_STEPS.map((step) => step.id)).toEqual([
      'navigation', 'code', 'work', 'omni', 'providers', 'connected-apps', 'activity', 'notifications', 'settings'
    ])
    expect(TOUR_STEPS.some((step) => /translation|window-capture|ocr/u.test(step.id))).toBe(false)
    expect(nextTourIndex(0, -1)).toBe(0)
    expect(nextTourIndex(0, 1)).toBe(1)
    expect(nextTourIndex(8, 1)).toBe(8)
    const html = renderToStaticMarkup(createElement(GuidedTour, { onPrepare: () => undefined, onFinish: () => undefined }))
    expect(html).toContain('Back')
    expect(html).toContain('Next')
    expect(html).toContain('Skip Tour')
    expect(html).toContain('1 of 9')
  })
})
