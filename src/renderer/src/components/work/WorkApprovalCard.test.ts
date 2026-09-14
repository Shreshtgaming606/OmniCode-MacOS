import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkApprovalRequest } from '../../../../shared/tool-contracts'
import { FullAccessWarning } from './FullAccessWarning'
import { WorkApprovalCard } from './WorkApprovalCard'

const request: WorkApprovalRequest = {
  id: 'approval-1',
  toolId: 'gmail.send',
  toolName: 'Send Gmail message',
  connectorId: 'gmail',
  connectorName: 'Gmail',
  category: 'communication',
  risk: 'medium',
  approvalMode: 'auto',
  title: 'Send this email?',
  summary: 'This sends a message outside the chat.',
  reason: 'External communication requires approval.',
  details: [
    { label: 'To', value: 'recipient@example.com' },
    { label: 'Subject', value: 'Exact subject' },
    { label: 'Message', value: 'Exact body', multiline: true }
  ]
}

describe('Work approval UI', () => {
  it('renders the exact important action parameters and one-time decision controls', () => {
    const html = renderToStaticMarkup(createElement(WorkApprovalCard, { request, onResolve: () => undefined }))
    expect(html).toContain('Send this email?')
    expect(html).toContain('recipient@example.com')
    expect(html).toContain('Exact subject')
    expect(html).toContain('Exact body')
    expect(html).toContain('Approve once')
    expect(html).toContain('Cancel')
    expect(html).not.toContain('Always allow')
  })

  it('explains Full access without claiming that hard boundaries disappear', () => {
    const html = renderToStaticMarkup(createElement(FullAccessWarning, { onEnable: () => undefined, onCancel: () => undefined }))
    expect(html).toContain('Turn on Full access?')
    expect(html).toContain('Hard safety boundaries stay active')
    expect(html).toContain('Instructions inside emails, files, websites, or model responses can never grant access')
  })
})
