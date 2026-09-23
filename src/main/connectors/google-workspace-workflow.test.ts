import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AIManager } from '../services/ai-manager'
import type { GoogleOAuthManager } from '../services/google-oauth-manager'
import { ToolRegistry } from '../services/tool-registry'
import { WorkAgentManager } from '../services/work-agent-manager'
import { WorkTransferStore } from '../services/work-transfer-store'
import { GmailConnector } from './gmail-connector'
import { GoogleDriveConnector } from './google-drive-connector'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function oauthMock(): GoogleOAuthManager {
  return {
    connect: vi.fn(), disconnect: vi.fn(),
    verify: vi.fn(async () => ({ state: 'connected', message: 'Connected.', checkedAt: new Date(0).toISOString(), grantedScopes: [] })),
    getAccessToken: vi.fn(async () => 'google-access-token')
  } as unknown as GoogleOAuthManager
}

async function transferStore(): Promise<WorkTransferStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-google-workflow-'))
  roots.push(root)
  return new WorkTransferStore(root)
}

function gmailMessage() {
  return {
    id: 'message-1', threadId: 'thread-1', labelIds: ['INBOX'], snippet: 'Attached report',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'teacher@example.com' },
        { name: 'To', value: 'person@example.com' },
        { name: 'Subject', value: 'Today report' }
      ],
      parts: [{
        mimeType: 'application/pdf', filename: 'teacher-report.pdf',
        body: { attachmentId: 'attachment-1', size: 17 }
      }]
    }
  }
}

function driveFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'drive-file-1', name: 'Latest resume.pdf', mimeType: 'application/pdf', size: '17',
    createdTime: '2026-09-08T10:00:00.000Z', modifiedTime: '2026-09-09T10:00:00.000Z',
    parents: ['root'], trashed: false, webViewLink: 'https://drive.google.com/file/d/drive-file-1/view',
    ...overrides
  }
}

describe('Google Workspace cross-connector workflows', () => {
  it('chains Gmail search → attachment retrieval → routine Drive upload without approval spam in Approve for me mode', async () => {
    const transfers = await transferStore()
    const attachmentBytes = Buffer.from('%PDF-teacher-data')
    let uploadedBody = Buffer.alloc(0)
    const gmailFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'message-1' }], resultSizeEstimate: 1 })
      if (url.includes('/attachments/attachment-1')) return Response.json({ data: attachmentBytes.toString('base64url'), size: attachmentBytes.byteLength })
      if (url.includes('/messages/message-1?')) return Response.json(gmailMessage())
      throw new Error(`Unexpected Gmail URL: ${url}`)
    })
    const driveFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/upload/drive/')) {
        if (!(init?.body instanceof Uint8Array)) throw new Error('Expected binary multipart upload.')
        uploadedBody = Buffer.from(init.body)
        return Response.json(driveFile({ name: 'teacher-report.pdf', size: String(attachmentBytes.byteLength) }))
      }
      throw new Error(`Unexpected Drive URL: ${url}`)
    })
    const registry = new ToolRegistry()
    new GmailConnector(oauthMock(), gmailFetch as unknown as typeof fetch, transfers).registerTools(registry)
    new GoogleDriveConnector(oauthMock(), driveFetch as unknown as typeof fetch, transfers).registerTools(registry)
    let turn = 0
    const toolTurn = vi.fn(async (request: { messages: Array<{ role: string; content: string }> }) => {
      turn++
      if (turn === 1) return { content: '', calls: [{ callId: 'call-search', name: 'gmail_search', toolId: 'gmail.search', input: { query: 'from:teacher newer_than:1d has:attachment', maximum: 5 } }] }
      if (turn === 2) return { content: '', calls: [{ callId: 'call-download', name: 'gmail_download', toolId: 'gmail.download-attachment', input: { messageId: 'message-1', attachmentId: 'attachment-1' } }] }
      if (turn === 3) {
        const result = JSON.parse(request.messages.at(-1)!.content) as { result: { id: string } }
        return { content: '', calls: [{ callId: 'call-upload', name: 'drive_upload', toolId: 'drive.upload-transfer', input: { transferId: result.result.id } }] }
      }
      return { content: 'The attachment was uploaded to Google Drive.', calls: [] }
    })
    const manager = new WorkAgentManager({ toolTurn } as unknown as AIManager)
    const confirm = vi.fn(async () => true)
    const tools = registry.list('work')

    const response = await manager.chat({
      provider: 'openai', model: 'gpt-test',
      messages: [{ role: 'user', content: 'Find the PDF my teacher emailed today and save it to Drive.' }]
    }, tools, (request) => registry.execute(request, { accessLevel: 'ask-before-changes', approvalMode: 'auto', confirm }))

    expect(response).toMatchObject({ content: 'The attachment was uploaded to Google Drive.', toolCallCount: 3 })
    expect(response.toolActivities.map((activity) => activity.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(uploadedBody.includes(attachmentBytes)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    const modelPayload = JSON.stringify(toolTurn.mock.calls)
    expect(modelPayload).not.toContain(attachmentBytes.toString('base64'))
    expect(modelPayload).not.toContain(attachmentBytes.toString())
  })

  it('chains Drive search → file retrieval → confirmed Gmail draft with the exact attachment bytes', async () => {
    const transfers = await transferStore()
    const resumeBytes = Buffer.from('%PDF-resume-data')
    let draftMime = ''
    const driveFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/files?')) return Response.json({ files: [driveFile()] })
      if (url.includes('fields=')) return Response.json(driveFile())
      if (url.includes('alt=media')) return new Response(resumeBytes)
      throw new Error(`Unexpected Drive URL: ${url}`)
    })
    const gmailFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/drafts')) {
        const payload = JSON.parse(String(init?.body)) as { message: { raw: string } }
        draftMime = Buffer.from(payload.message.raw, 'base64url').toString('utf8')
        return Response.json({ id: 'draft-1', message: { id: 'draft-message-1', threadId: 'draft-thread-1' } })
      }
      throw new Error(`Unexpected Gmail URL: ${url}`)
    })
    const registry = new ToolRegistry()
    new GmailConnector(oauthMock(), gmailFetch as unknown as typeof fetch, transfers).registerTools(registry)
    new GoogleDriveConnector(oauthMock(), driveFetch as unknown as typeof fetch, transfers).registerTools(registry)
    let turn = 0
    const toolTurn = vi.fn(async (request: { messages: Array<{ role: string; content: string }> }) => {
      turn++
      if (turn === 1) return { content: '', calls: [{ callId: 'call-search', name: 'drive_search', toolId: 'drive.search', input: { query: 'resume', maximum: 5 } }] }
      if (turn === 2) return { content: '', calls: [{ callId: 'call-download', name: 'drive_download', toolId: 'drive.download', input: { fileId: 'drive-file-1' } }] }
      if (turn === 3) {
        const result = JSON.parse(request.messages.at(-1)!.content) as { result: { id: string } }
        return { content: '', calls: [{ callId: 'call-draft', name: 'gmail_draft', toolId: 'gmail.draft', input: {
          to: ['alex@example.com'], subject: 'Latest resume', body: 'Hi Alex,\n\nI attached my latest resume.', transferIds: [result.result.id]
        } }] }
      }
      return { content: 'The Gmail draft is ready with your latest resume attached.', calls: [] }
    })
    const manager = new WorkAgentManager({ toolTurn } as unknown as AIManager)
    const confirm = vi.fn(async () => true)

    const response = await manager.chat({
      provider: 'openai', model: 'gpt-test',
      messages: [{ role: 'user', content: 'Find my latest resume in Drive and attach it to a Gmail draft for Alex.' }]
    }, registry.list('work'), (request) => registry.execute(request, { accessLevel: 'ask-before-changes', approvalMode: 'ask', confirm }))

    expect(response).toMatchObject({ content: 'The Gmail draft is ready with your latest resume attached.', toolCallCount: 3 })
    expect(draftMime).toContain('To: alex@example.com')
    expect(draftMime).toContain("filename*=UTF-8''Latest%20resume.pdf")
    expect(draftMime).toContain(resumeBytes.toString('base64'))
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ toolId: 'gmail.draft' }), undefined)
    expect(JSON.stringify(toolTurn.mock.calls)).not.toContain(resumeBytes.toString('base64'))
  })

  it('chains Gmail search → message read → AI summary with untrusted-content boundaries', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'message-1' }] })
      if (url.includes('/messages/message-1?')) return Response.json({
        ...gmailMessage(),
        payload: {
          ...gmailMessage().payload,
          parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('The release meeting is Friday at 2 PM.').toString('base64url') } }]
        }
      })
      throw new Error(`Unexpected Gmail URL: ${url}`)
    })
    const registry = new ToolRegistry()
    new GmailConnector(oauthMock(), fetchMock as unknown as typeof fetch).registerTools(registry)
    let turn = 0
    const toolTurn = vi.fn(async (request: { messages: Array<{ role: string; content: string }> }) => {
      turn++
      if (turn === 1) return { content: '', calls: [{ callId: 'summary-search', name: 'gmail_search', toolId: 'gmail.search', input: { query: 'is:unread newer_than:1d', maximum: 10 } }] }
      if (turn === 2) return { content: '', calls: [{ callId: 'summary-read', name: 'gmail_read', toolId: 'gmail.read', input: { messageId: 'message-1' } }] }
      expect(request.messages.at(-1)!.content).toContain('"untrustedContent":true')
      return { content: 'Your unread email says the release meeting is Friday at 2 PM.', calls: [] }
    })
    const response = await new WorkAgentManager({ toolTurn } as unknown as AIManager).chat({
      provider: 'openai', model: 'gpt-test', messages: [{ role: 'user', content: 'Summarize my unread email.' }]
    }, registry.list('work', 'gmail'), (request) => registry.execute(request, { accessLevel: 'ask-before-changes', approvalMode: 'ask', confirm: vi.fn() }))

    expect(response).toMatchObject({ content: expect.stringContaining('Friday at 2 PM'), toolCallCount: 2 })
  })

  it('chains Drive search → supported file read → AI analysis', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/files?')) return Response.json({ files: [driveFile({ name: 'Resume.txt', mimeType: 'text/plain' })] })
      if (url.includes('fields=')) return Response.json(driveFile({ name: 'Resume.txt', mimeType: 'text/plain' }))
      if (url.includes('alt=media')) return new Response('Experience: Swift and TypeScript. Missing measurable outcomes.')
      throw new Error(`Unexpected Drive URL: ${url}`)
    })
    const registry = new ToolRegistry()
    new GoogleDriveConnector(oauthMock(), fetchMock as unknown as typeof fetch).registerTools(registry)
    let turn = 0
    const toolTurn = vi.fn(async (request: { messages: Array<{ role: string; content: string }> }) => {
      turn++
      if (turn === 1) return { content: '', calls: [{ callId: 'analysis-search', name: 'drive_search', toolId: 'drive.search', input: { query: 'resume', maximum: 5 } }] }
      if (turn === 2) return { content: '', calls: [{ callId: 'analysis-read', name: 'drive_read', toolId: 'drive.read', input: { fileId: 'drive-file-1' } }] }
      expect(request.messages.at(-1)!.content).toContain('Missing measurable outcomes')
      expect(request.messages.at(-1)!.content).toContain('"untrustedContent":true')
      return { content: 'Add measurable outcomes to strengthen the resume.', calls: [] }
    })
    const response = await new WorkAgentManager({ toolTurn } as unknown as AIManager).chat({
      provider: 'openai', model: 'gpt-test', messages: [{ role: 'user', content: 'Find my resume and tell me what to improve.' }]
    }, registry.list('work', 'google-drive'), (request) => registry.execute(request, { accessLevel: 'ask-before-changes', approvalMode: 'ask', confirm: vi.fn() }))

    expect(response).toMatchObject({ content: expect.stringContaining('measurable outcomes'), toolCallCount: 2 })
  })
})
