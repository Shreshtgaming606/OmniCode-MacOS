import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OmniModeLogo } from './OmniModeLogo'

describe('Omni Mode logo', () => {
  it('uses the supplied visual source byte-for-byte without changing global app branding', () => {
    const source = readFileSync('src/renderer/src/assets/omni-mode-logo.jpg')
    expect(createHash('sha256').update(source).digest('hex')).toBe('9239da6c8e67f72c623523f79a392b33fbfce052a68dfdc23a1532ebb7533a13')
    const html = renderToStaticMarkup(createElement(OmniModeLogo))
    expect(html).toContain('Omni Mode logo')
    expect(html).toContain('omni-mode-logo.jpg')
  })
})
