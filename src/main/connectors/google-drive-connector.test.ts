import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GoogleOAuthManager } from '../services/google-oauth-manager'
import { ToolRegistry } from '../services/tool-registry'
import { WorkTransferStore } from '../services/work-transfer-store'
import { GoogleDriveConnector } from './google-drive-connector'

const transferRoots: string[] = []

afterEach(async () => {
  await Promise.all(transferRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function transferStore(): Promise<WorkTransferStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-drive-transfer-'))
  transferRoots.push(root)
  return new WorkTransferStore(root)
}

function oauthMock(): GoogleOAuthManager {
  return {
    connect: vi.fn(async () => ({ subject: 'account-1', email: 'person@example.com' })),
    verify: vi.fn(async () => ({ state: 'connected', message: 'Connected as person@example.com.', checkedAt: new Date(0).toISOString(), grantedScopes: ['https://www.googleapis.com/auth/drive'] })),
    disconnect: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async () => 'drive-access-token')
  } as unknown as GoogleOAuthManager
}

function driveFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name: 'Planning document',
    mimeType: 'text/plain',
    size: '42',
    createdTime: '2026-09-08T10:00:00.000Z',
    modifiedTime: '2026-09-09T10:00:00.000Z',
    parents: ['root'],
    trashed: false,
    webViewLink: 'https://drive.google.com/file/d/file-1/view',
    ...overrides
  }
}

describe('GoogleDriveConnector', () => {
  it('searches the Drive API with escaped text, bounded fields, and bearer auth', async () => {
    let requestedUrl = ''
    let authorization = ''
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input)
      authorization = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response(JSON.stringify({ files: [driveFile()], nextPageToken: 'next-page' }), { status: 200 })
    }) as unknown as typeof fetch
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock)

    await expect(connector.search("team's plan", 10)).resolves.toMatchObject({
      files: [{ id: 'file-1', name: 'Planning document', untrustedContent: true }],
      nextPageToken: 'next-page',
      untrustedContent: true
    })
    const query = new URL(requestedUrl).searchParams.get('q') ?? ''
    expect(query).toBe("fullText contains 'team\\'s plan' and trashed = false")
    expect(authorization).toBe('Bearer drive-access-token')
  })

  it('exports Google Docs to bounded text and marks returned content untrusted', async () => {
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('fields=')) return new Response(JSON.stringify(driveFile({ mimeType: 'application/vnd.google-apps.document' })), { status: 200 })
      if (url.includes('/export?')) return new Response('Document text', { status: 200, headers: { 'Content-Type': 'text/plain' } })
      throw new Error(`Unexpected URL: ${url}`)
    }) as unknown as typeof fetch
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock)

    await expect(connector.readText('file-1')).resolves.toMatchObject({
      text: 'Document text',
      exportedAs: 'text/plain',
      untrustedContent: true
    })
    expect(new URL(urls[1] as string).searchParams.get('mimeType')).toBe('text/plain')
  })

  it('refuses to inject binary Drive bytes into AI context', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(driveFile({ mimeType: 'application/pdf' })), { status: 200 })) as unknown as typeof fetch
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock)

    await expect(connector.readText('file-1')).rejects.toThrow('binary')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refuses invalid UTF-8 even when Drive metadata claims a text media type', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('fields=')) return Response.json(driveFile({ mimeType: 'text/plain' }))
      return new Response(Uint8Array.from([0xff, 0xfe, 0x00]))
    }) as unknown as typeof fetch
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock)

    await expect(connector.readText('file-1')).rejects.toThrow('not valid UTF-8')
  })

  it('uploads bounded text with multipart metadata while keeping auth in the main-process request', async () => {
    let requestBody = ''
    let contentType = ''
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body)
      contentType = new Headers(init?.headers).get('Content-Type') ?? ''
      return new Response(JSON.stringify(driveFile({ name: 'notes.md', mimeType: 'text/markdown' })), { status: 200 })
    }) as unknown as typeof fetch
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock)

    await expect(connector.upload({ name: 'notes.md', mimeType: 'text/markdown', content: '# Notes', parentId: 'root' })).resolves.toMatchObject({ name: 'notes.md' })
    expect(contentType).toMatch(/^multipart\/related; boundary=omnicode_/u)
    expect(requestBody).toContain('"parents":["root"]')
    expect(requestBody).toContain('# Notes')
  })

  it('downloads binary files to opaque transfers and uploads the exact bytes', async () => {
    const transfers = await transferStore()
    const bytes = Buffer.from('%PDF-private-resume')
    let uploaded = Buffer.alloc(0)
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/upload/drive/')) {
        const body = init?.body
        if (!(body instanceof Uint8Array)) throw new Error('Expected a binary multipart body.')
        uploaded = Buffer.from(body)
        return Response.json(driveFile({ id: 'uploaded-1', name: 'resume.pdf', mimeType: 'application/pdf', size: String(bytes.byteLength) }))
      }
      if (url.includes('fields=')) return Response.json(driveFile({ name: 'resume.pdf', mimeType: 'application/pdf', size: String(bytes.byteLength) }))
      if (url.includes('alt=media')) return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      throw new Error(`Unexpected URL: ${url}`)
    })
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock as unknown as typeof fetch, transfers)
    const transfer = await connector.download('file-1')

    expect(transfer).toMatchObject({ filename: 'resume.pdf', mimeType: 'application/pdf', sizeBytes: bytes.byteLength, source: 'google-drive' })
    expect(transfer).not.toHaveProperty('path')
    await expect(connector.uploadTransfer(String(transfer.id), 'root')).resolves.toMatchObject({ id: 'uploaded-1' })
    expect(uploaded.includes(bytes)).toBe(true)
  })

  it('exports native Google Workspace files to PDF for attachment transfers', async () => {
    const transfers = await transferStore()
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('fields=')) return Response.json(driveFile({ name: 'Latest resume', mimeType: 'application/vnd.google-apps.document', size: '0' }))
      if (url.includes('/export?')) return new Response('%PDF-export', { status: 200 })
      throw new Error(`Unexpected URL: ${url}`)
    })
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock as unknown as typeof fetch, transfers)

    await expect(connector.download('file-1')).resolves.toMatchObject({ filename: 'Latest resume.pdf', mimeType: 'application/pdf' })
    expect(new URL(urls[1] as string).searchParams.get('mimeType')).toBe('application/pdf')
  })

  it('saves a Drive file only through the injected native destination boundary', async () => {
    const transfers = await transferStore()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('fields=')) return Response.json(driveFile({ name: 'download.pdf', mimeType: 'application/pdf', size: '9' }))
      if (url.includes('alt=media')) return new Response('pdf-bytes')
      throw new Error(`Unexpected URL: ${url}`)
    })
    const saveTransfer = vi.fn(async () => ({ saved: true, cancelled: false, filename: 'chosen.pdf', sizeBytes: 9 }))
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock as unknown as typeof fetch, transfers, saveTransfer)

    await expect(connector.saveLocal('file-1')).resolves.toMatchObject({ saved: true, filename: 'chosen.pdf' })
    expect(saveTransfer).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/u))
  })

  it('registers read and mutating Drive tools with confirmation for high-impact actions', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(driveFile({ trashed: true })), { status: 200 })) as unknown as typeof fetch
    const registry = new ToolRegistry()
    new GoogleDriveConnector(oauthMock(), fetchMock).registerTools(registry)
    const tools = registry.list('work', 'google-drive')

    expect(tools.map((tool) => tool.id)).toEqual([
      'drive.search', 'drive.recent', 'drive.folder', 'drive.metadata', 'drive.read', 'drive.download', 'drive.save-local',
      'drive.create-folder', 'drive.upload-text', 'drive.upload-transfer', 'drive.rename', 'drive.move',
      'drive.copy', 'drive.trash', 'drive.restore'
    ])
    expect(tools.find((tool) => tool.id === 'drive.read')).toMatchObject({ action: 'read', confirmation: 'never' })
    expect(tools.find((tool) => tool.id === 'drive.trash')).toMatchObject({ action: 'destructive', confirmation: 'always' })

    await expect(registry.execute(
      { toolId: 'drive.trash', mode: 'work', input: { fileId: 'file-1' } },
      { accessLevel: 'ask-before-changes', confirm: async () => false }
    )).rejects.toThrow('cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid IDs and unsupported upload media before any Drive request', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch
    const connector = new GoogleDriveConnector(oauthMock(), fetchMock)

    await expect(connector.metadata('../outside')).rejects.toThrow('file ID is invalid')
    await expect(connector.upload({ name: 'payload.bin', mimeType: 'application/octet-stream', content: 'bytes' })).rejects.toThrow('Only bounded text')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps Drive network failures to a useful bounded error', async () => {
    const connector = new GoogleDriveConnector(oauthMock(), vi.fn(async () => { throw new TypeError('fetch failed at secret host') }) as unknown as typeof fetch)
    await expect(connector.metadata('file-1')).rejects.toThrow('Google Drive could not be reached')
  })
})
