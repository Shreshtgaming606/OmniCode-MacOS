import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LiveActivityCard, type LiveActivityEntry } from './LiveActivityCard'

const entries: LiveActivityEntry[] = [
  { id: 'read', title: 'Reading package.json', status: 'completed', startedAt: 1_000, completedAt: 1_400 },
  { id: 'search', title: 'Searching workspace', status: 'completed', startedAt: 1_500, completedAt: 2_000 },
  { id: 'test', title: 'Running npm test', status: 'running', startedAt: 2_100 }
]

describe('LiveActivityCard', () => {
  it('renders a compact current step and completed count without private reasoning', () => {
    const html = renderToStaticMarkup(createElement(LiveActivityCard, {
      mode: 'Code', status: 'running', startedAt: 1_000, entries, modelLabel: 'Ollama · qwen3:4b'
    }))
    expect(html).toContain('OmniCode is working')
    expect(html).toContain('Running npm test')
    expect(html).toContain('2 completed')
    expect(html).not.toContain('Reading package.json')
    expect(html).not.toContain('internal reasoning')
  })

  it('renders ordered activity, retry, failure, and completion summary states when expanded', () => {
    const html = renderToStaticMarkup(createElement(LiveActivityCard, {
      mode: 'Work', status: 'failed', startedAt: 1_000, completedAt: 4_000, defaultExpanded: true,
      entries: [...entries.slice(0, 2), { id: 'retry', title: 'Searching Gmail again', status: 'retrying', startedAt: 2_100 }, { id: 'fail', title: 'Gmail search failed', status: 'failed', startedAt: 3_000, completedAt: 4_000 }]
    }))
    expect(html.indexOf('Reading package.json')).toBeLessThan(html.indexOf('Searching workspace'))
    expect(html).toContain('Searching Gmail again')
    expect(html).toContain('Gmail search failed')
    expect(html).toContain('Task failed')
    expect(html).toContain('00:03')
    expect(html).toContain('Operational activity only')
  })
})
