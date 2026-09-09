import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorkModeShell, type WorkModeShellProps } from './WorkModeShell'

const props: WorkModeShellProps = {
  conversations: [],
  currentConversation: null,
  searchQuery: '',
  composerValue: '',
  selectedProvider: 'ollama',
  selectedModelId: '',
  modelCatalog: [],
  connectedApps: [],
  pendingAttachments: [],
  onSearchChange: () => undefined,
  onComposerChange: () => undefined,
  onCreateConversation: () => undefined,
  onSelectConversation: () => undefined,
  onRenameConversation: () => undefined,
  onDeleteConversation: () => undefined,
  onTogglePin: () => undefined,
  onSend: () => undefined,
  onStop: () => undefined,
  onSelectAttachments: () => undefined,
  onDropAttachments: () => undefined,
  onRemoveAttachment: () => undefined,
  onCopyMessage: () => undefined,
  onEditMessage: () => undefined,
  onRegenerateMessage: () => undefined,
  onProviderChange: () => undefined,
  onModelChange: () => undefined,
  onRefreshModels: () => undefined,
  onOpenSettings: () => undefined,
  onOpenConnectedApps: () => undefined,
  onOpenConnectedApp: () => undefined,
  onLinkError: () => undefined
}

describe('WorkModeShell', () => {
  it('renders a separate Work conversation shell without claiming an app connection', () => {
    const html = renderToStaticMarkup(createElement(WorkModeShell, props))

    expect(html).toContain('Work Mode')
    expect(html).toContain('What can OmniCode help with?')
    expect(html).toContain('No apps configured')
    expect(html).not.toContain('>Connected<')
    expect(html).not.toContain('processed on this Mac')
  })

  it('always renders a model selector instead of a manual model-name input', () => {
    const html = renderToStaticMarkup(createElement(WorkModeShell, props))

    expect(html).toContain('aria-label="Work AI model"')
    expect(html).toContain('No available models')
    expect(html).not.toContain('AI model name')
  })

  it('replaces Send with an actual Stop Generation control while a request runs', () => {
    const html = renderToStaticMarkup(createElement(WorkModeShell, { ...props, sending: true }))

    expect(html).toContain('aria-label="Stop Work generation"')
    expect(html).not.toContain('aria-label="Send Work message"')
  })

  it('offers copy, edit, and regenerate controls for the current exchange', () => {
    const html = renderToStaticMarkup(createElement(WorkModeShell, {
      ...props,
      currentConversation: {
        id: 'chat-1', title: 'Test chat', createdAt: 1, updatedAt: 2, pinned: false,
        provider: 'google', modelId: 'gemini-test', messageCount: 2,
        messages: [
          { id: 'user-1', role: 'user', content: 'Hello', createdAt: 1, status: 'complete' },
          { id: 'assistant-1', role: 'assistant', content: 'Hi there', createdAt: 2, status: 'complete' }
        ]
      }
    }))

    expect(html).toContain('aria-label="Edit message"')
    expect(html).toContain('aria-label="Copy response"')
    expect(html).toContain('aria-label="Regenerate response"')
  })

  it('renders a removable pending attachment and a Mac file picker control', () => {
    const html = renderToStaticMarkup(createElement(WorkModeShell, {
      ...props,
      pendingAttachments: [{
        id: 'attachment-1', name: 'notes.md', kind: 'file', source: 'computer', createdAt: 1,
        mimeType: 'text/markdown', sizeBytes: 1200
      }]
    }))

    expect(html).toContain('aria-label="Attach files"')
    expect(html).toContain('notes.md')
    expect(html).toContain('aria-label="Remove notes.md"')
  })
})
