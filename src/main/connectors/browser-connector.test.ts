import { describe, expect, it, vi } from 'vitest'

import { ToolRegistry } from '../services/tool-registry'
import {
  BrowserConnector,
  isPrivateNetworkAddress,
  type ManagedBrowserPage,
  validateBrowserUrl
} from './browser-connector'

function fakePage(): ManagedBrowserPage {
  return {
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ title: 'Example', url: 'https://example.com/', text: 'Needle in a real page snapshot.' })),
    findText: vi.fn(async () => ({ count: 1, excerpts: ['Needle in a real page snapshot.'] })),
    show: vi.fn(),
    destroy: vi.fn(),
    clearStorage: vi.fn(async () => undefined)
  }
}

describe('BrowserConnector security boundary', () => {
  it('accepts credential-free HTTPS and rejects local, private, file, HTTP, and credential-bearing URLs', () => {
    expect(validateBrowserUrl('https://example.com/path').hostname).toBe('example.com')
    for (const value of ['http://example.com', 'file:///etc/passwd', 'https://localhost/', 'https://127.0.0.1/', 'https://192.168.1.2/', 'https://user:secret@example.com/']) {
      expect(() => validateBrowserUrl(value)).toThrow()
    }
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.1.1', '198.18.0.1', '203.0.113.4', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.2']) {
      expect(isPrivateNetworkAddress(address)).toBe(true)
    }
    expect(isPrivateNetworkAddress('93.184.216.34')).toBe(false)
  })

  it('does not claim connected before a real page exists and clears isolated state on disconnect', async () => {
    const page = fakePage()
    const connector = new BrowserConnector({ createPage: async () => page, resolveHost: async () => ['93.184.216.34'] })
    expect((await connector.verify()).state).toBe('not-connected')
    await connector.connect()
    expect((await connector.verify()).state).toBe('connected')
    await connector.disconnect()
    expect(page.destroy).toHaveBeenCalledOnce()
    expect(page.clearStorage).toHaveBeenCalledOnce()
    expect((await connector.verify()).state).toBe('not-connected')
  })

  it('preflights DNS, opens the exact page, and returns only bounded normalized page data', async () => {
    const page = fakePage()
    const connector = new BrowserConnector({ createPage: async () => page, resolveHost: async () => ['93.184.216.34'] })
    await connector.connect()
    await expect(connector.open('https://example.com/')).resolves.toMatchObject({ title: 'Example' })
    expect(page.loadURL).toHaveBeenCalledWith('https://example.com/')
    expect(page.show).toHaveBeenCalledOnce()

    const blocked = new BrowserConnector({ createPage: async () => fakePage(), resolveHost: async () => ['10.0.0.8'] })
    await blocked.connect()
    await expect(blocked.open('https://example.com/')).rejects.toThrow(/private-network/i)
  })

  it('registers fixed read-only Work tools rather than accepting model-generated code', async () => {
    const page = fakePage()
    const connector = new BrowserConnector({ createPage: async () => page, resolveHost: async () => ['93.184.216.34'] })
    await connector.connect()
    const registry = new ToolRegistry()
    connector.registerTools(registry)
    expect(registry.list('work').map((tool) => tool.id)).toEqual(['browser.open', 'browser.read', 'browser.find'])
    expect(registry.list('code')).toEqual([])
    const authorization = { accessLevel: 'read-only' as const, confirm: vi.fn(async () => false) }
    const result = await registry.execute({ toolId: 'browser.find', mode: 'work', input: { query: 'Needle' } }, authorization)
    expect(result.result).toEqual({ count: 1, excerpts: ['Needle in a real page snapshot.'] })
    expect(authorization.confirm).not.toHaveBeenCalled()
  })
})
