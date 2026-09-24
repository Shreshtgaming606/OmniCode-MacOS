import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { suggestionsForConnectedApps, WorkModeShell, type WorkModeShellProps } from './WorkModeShell'

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
  approvalMode: 'ask',
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
  onVerifyGeminiConfiguration: () => undefined,
  onSetWorkspaceConsent: () => undefined,
  onApprovalModeChange: () => undefined,
  onOpenActivity: () => undefined,
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
    expect(html).not.toContain('using the connected browser')
    expect(html).not.toContain('Gmail')
    expect(html).toContain('Work action approvals: Ask for approval')
    expect(html).toContain('Approve for me')
    expect(html).toContain('Full access')
    expect(html).toContain('Activity')
  })

  it('offers connector-specific suggestions only for actually connected services', () => {
    const suggestions = suggestionsForConnectedApps([
      { id: 'browser', name: 'Managed Browser', state: 'connected' },
      { id: 'gmail', name: 'Gmail', state: 'permission-missing' },
      { id: 'google-drive', name: 'Google Drive', state: 'not-connected' }
    ])

    expect(suggestions).toContain('Research a topic using the connected browser')
    expect(suggestions.some((suggestion) => suggestion.includes('Gmail'))).toBe(false)
    expect(suggestions.some((suggestion) => suggestion.includes('Google Drive'))).toBe(false)
  })

  it('prioritizes a cross-connector suggestion only when Gmail and Drive are both connected', () => {
    expect(suggestionsForConnectedApps([
      { id: 'gmail', name: 'Gmail', state: 'connected' },
      { id: 'google-drive', name: 'Google Drive', state: 'connected' }
    ])[0]).toBe('Find an email attachment and save it to Drive')
    expect(suggestionsForConnectedApps([
      { id: 'gmail', name: 'Gmail', state: 'connected' },
      { id: 'google-drive', name: 'Google Drive', state: 'network-error' }
    ])).not.toContain('Find an email attachment and save it to Drive')
  })

  it('groups unpinned conversation history by recency', () => {
    const now = Date.now()
    const html = renderToStaticMarkup(createElement(WorkModeShell, {
      ...props,
      conversations: [
        { id: 'today', title: 'Today chat', createdAt: now, updatedAt: now, pinned: false, provider: 'ollama', modelId: '', messageCount: 0 },
        { id: 'week', title: 'Week chat', createdAt: now - 172_800_000, updatedAt: now - 172_800_000, pinned: false, provider: 'ollama', modelId: '', messageCount: 0 },
        { id: 'old', title: 'Old chat', createdAt: 1, updatedAt: 1, pinned: false, provider: 'ollama', modelId: '', messageCount: 0 }
      ]
    }))

    expect(html).toContain('Today')
    expect(html).toContain('Previous 7 days')
    expect(html).toContain('Older')
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

  it('renders safe Gmail and Drive result previews as readable cards', () => {
    const html = renderToStaticMarkup(createElement(WorkModeShell, {
      ...props,
      currentConversation: {
        id: 'chat-cards', title: 'Connector cards', createdAt: 1, updatedAt: 2, pinned: false,
        provider: 'google', modelId: 'gemini-test', messageCount: 1,
        messages: [{
          id: 'assistant-cards', role: 'assistant', content: 'Here are the results.', createdAt: 2, status: 'complete',
          toolActivities: [
            {
              id: 'activity-mail', toolId: 'gmail.search', name: 'Search Gmail', connectorId: 'gmail', status: 'succeeded', createdAt: 1,
              preview: { kind: 'gmail-messages', label: 'Gmail results', count: 6, truncated: true, items: [{ title: 'Launch plan', subtitle: 'Alex', detail: 'The release candidate is ready.', metadata: 'Today' }] }
            },
            {
              id: 'activity-drive', toolId: 'drive.search', name: 'Search Google Drive', connectorId: 'google-drive', status: 'succeeded', createdAt: 1,
              preview: { kind: 'drive-files', label: 'Google Drive results', count: 1, items: [{ title: 'Resume.pdf', subtitle: 'application/pdf', metadata: '2 KB' }] }
            }
          ]
        }]
      }
    }))

    expect(html).toContain('aria-label="Gmail results"')
    expect(html).toContain('Launch plan')
    expect(html).toContain('The release candidate is ready.')
    expect(html).toContain('aria-label="Google Drive results"')
    expect(html).toContain('Resume.pdf')
    expect(html).not.toContain('private-drive-id')
  })

  it('keeps Gmail visibly connected while an unknown Gemini configuration blocks model access', () => {
    const html = renderToStaticMarkup(createElement(WorkModeShell, {
      ...props,
      selectedProvider: 'google', selectedModelId: 'gemini-test',
      modelCatalog: [{
        id: 'gemini-test', provider: 'google', displayName: 'Gemini Test', local: false,
        availability: 'available', capabilities: {
          chat: { support: 'supported', evidence: 'provider-api' }, streaming: { support: 'supported', evidence: 'provider-api' },
          'tool-calling': { support: 'supported', evidence: 'provider-api' }, vision: { support: 'unknown', evidence: 'unknown' },
          coding: { support: 'unknown', evidence: 'unknown' }, 'large-context': { support: 'unknown', evidence: 'unknown' },
          'structured-output': { support: 'unknown', evidence: 'unknown' }
        }, metadataSource: 'provider-api'
      }],
      connectedApps: [{ id: 'gmail', name: 'Gmail', state: 'connected', detail: 'Connected and verified' }],
      providerPolicy: {
        provider: 'google', model: 'gemini-test', displayName: 'Google Gemini Developer API',
        verificationState: 'UNKNOWN', verificationMethod: 'none', workspaceDataEligible: false,
        allowsGoogleWorkspaceData: false, consentRequired: true, consentGranted: false, plan: 'unknown',
        zeroDataRetention: 'unknown', cloud: true, endpointType: 'Gemini API', retention: 'Unknown', training: 'Unknown',
        dataRegion: 'Unknown', rationale: 'Paid status cannot be verified.', lastReviewed: '2026-09-23', documentationUrls: ['https://ai.google.dev/']
      }
    }))

    expect(html).toContain('<strong>Gmail</strong>')
    expect(html).toContain('Connected and verified')
    expect(html).toContain('AI access: Unavailable with current Google configuration')
    expect(html).toContain('Verify Gemini Configuration')
    expect(html).not.toContain('Gmail is not connected')
  })
})
