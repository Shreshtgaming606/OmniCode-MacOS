import type { MouseEvent, ReactNode } from 'react'
import Markdown from 'react-markdown'

export function MarkdownMessage({ content, onLinkError }: { content: string; onLinkError(message: string): void }): ReactNode {
  return <div className="message-markdown">
    <Markdown components={{
      a: ({ href, children, ...properties }) => <a
        {...properties}
        href={href}
        rel="noreferrer"
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault()
          if (!href?.startsWith('https://')) {
            onLinkError('OmniCode opens only secure external links.')
            return
          }
          void window.omnicode.app.openExternal(href).catch((cause: unknown) => {
            onLinkError(cause instanceof Error ? cause.message : String(cause))
          })
        }}
      >{children}</a>
    }}>
      {content}
    </Markdown>
  </div>
}
