import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SourceControlView } from './SourceControlView'

describe('SourceControlView repository entry points', () => {
  it('exposes consistent Open and Clone Repository actions', () => {
    const html = renderToStaticMarkup(createElement(SourceControlView, {
      root: '/tmp/project',
      onOpenDiff: () => undefined,
      onStatus: () => undefined,
      onRequestText: async () => null,
      onOpenRepository: () => undefined,
      onCloneRepository: () => undefined
    }))

    expect(html).toContain('title="Open Existing Repository"')
    expect(html).toContain('title="Clone Repository"')
  })
})
