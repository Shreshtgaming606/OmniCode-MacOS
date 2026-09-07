import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'

function render(content: string): string {
  return renderToStaticMarkup(createElement(MarkdownMessage, { content, onLinkError: () => {} }))
}

describe('MarkdownMessage', () => {
  it('renders headings, lists, inline code, and fenced language code', () => {
    const html = render('## Result\n\n- one\n- `two`\n\n```ts\nconst answer = 42\n```')
    expect(html).toContain('<h2>Result</h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>two</code>')
    expect(html).toContain('<pre><code class="language-ts">const answer = 42')
  })

  it('does not turn raw HTML into executable markup', () => {
    const html = render('Before<script>globalThis.compromised=true</script>After')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;globalThis.compromised=true&lt;/script&gt;')
  })
})
