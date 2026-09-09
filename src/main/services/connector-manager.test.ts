import { describe, expect, it, vi } from 'vitest'

import type { ConnectorStatus } from '../../shared/tool-contracts'
import { ConnectorManager, type ConnectorAdapter } from './connector-manager'

function adapter(status: () => ConnectorStatus): ConnectorAdapter {
  return {
    descriptor: {
      id: 'browser',
      name: 'Managed Browser',
      description: 'A dedicated browser session controlled by Work mode.',
      capabilities: ['Open pages', 'Read visible page'],
      requestedScopes: [],
      accessLevel: 'read-only'
    },
    connect: vi.fn(async () => undefined),
    verify: vi.fn(async () => status()),
    disconnect: vi.fn(async () => undefined)
  }
}

describe('ConnectorManager', () => {
  it('starts as not connected and never infers connection from registration', async () => {
    const manager = new ConnectorManager()
    manager.register(adapter(() => ({ connectorId: 'browser', state: 'connected', message: 'Verified.', checkedAt: new Date().toISOString(), grantedScopes: [] })))
    expect((await manager.list())[0]?.status.state).toBe('not-connected')
    expect((await manager.list(true))[0]?.status.state).toBe('connected')
  })

  it('requires a successful verification after connect', async () => {
    const manager = new ConnectorManager()
    const connector = adapter(() => ({ connectorId: 'browser', state: 'network-error', message: 'The managed page could not be reached.', grantedScopes: [] }))
    manager.register(connector)
    const result = await manager.connect('browser')
    expect(connector.connect).toHaveBeenCalledOnce()
    expect(connector.verify).toHaveBeenCalledOnce()
    expect(result.state).toBe('network-error')
  })

  it('disconnects and verifies that access is gone', async () => {
    let connected = true
    const connector = adapter(() => ({ connectorId: 'browser', state: connected ? 'connected' : 'not-connected', message: connected ? 'Verified.' : 'Not connected.', grantedScopes: [] }))
    connector.disconnect = vi.fn(async () => { connected = false })
    const manager = new ConnectorManager()
    manager.register(connector)
    await manager.verify('browser')
    expect((await manager.disconnect('browser')).state).toBe('not-connected')
  })

  it('converts verification exceptions into an honest unavailable state', async () => {
    const connector = adapter(() => { throw new Error('network offline') })
    const manager = new ConnectorManager()
    manager.register(connector)
    await expect(manager.verify('browser')).resolves.toMatchObject({ state: 'service-unavailable' })
  })

  it('redacts credential-like values from verification and disconnect failures', async () => {
    const connector = adapter(() => {
      throw new Error('Authorization: Bearer secret-access-token; password=hunter2')
    })
    const manager = new ConnectorManager()
    manager.register(connector)
    const verified = await manager.verify('browser')
    expect(verified.message).toContain('••••')
    expect(verified.message).not.toContain('secret-access-token')
    expect(verified.message).not.toContain('hunter2')

    connector.disconnect = vi.fn(async () => {
      throw new Error('https://example.com/?access_token=another-secret')
    })
    const disconnected = await manager.disconnect('browser')
    expect(disconnected.state).toBe('service-unavailable')
    expect(disconnected.message).not.toContain('another-secret')
  })

  it('snapshots validated descriptor metadata instead of trusting later adapter mutation', async () => {
    const connector = adapter(() => ({ connectorId: 'browser', state: 'not-connected', message: 'Not connected.', grantedScopes: [] }))
    const manager = new ConnectorManager()
    manager.register(connector)
    ;(connector.descriptor as { name: string; accessLevel: string }).name = 'Changed later'
    ;(connector.descriptor as { name: string; accessLevel: string }).accessLevel = 'trusted'

    await expect(manager.list()).resolves.toMatchObject([{
      name: 'Managed Browser',
      accessLevel: 'read-only'
    }])
  })

  it('serializes operations for the same connector so a later disconnect wins', async () => {
    let releaseConnect: (() => void) | undefined
    let connected = false
    const connector = adapter(() => ({
      connectorId: 'browser',
      state: connected ? 'connected' : 'not-connected',
      message: connected ? 'Verified.' : 'Not connected.',
      grantedScopes: []
    }))
    connector.connect = vi.fn(() => new Promise<void>((resolve) => {
      releaseConnect = () => { connected = true; resolve() }
    }))
    connector.disconnect = vi.fn(async () => { connected = false })
    const manager = new ConnectorManager()
    manager.register(connector)

    const connecting = manager.connect('browser')
    const disconnecting = manager.disconnect('browser')
    await vi.waitFor(() => expect(releaseConnect).toBeTypeOf('function'))
    releaseConnect?.()

    await expect(connecting).resolves.toMatchObject({ state: 'connected' })
    await expect(disconnecting).resolves.toMatchObject({ state: 'not-connected' })
    expect(connector.disconnect).toHaveBeenCalledOnce()
  })

  it('rejects malformed descriptor and status collections without crashing list callers', async () => {
    const manager = new ConnectorManager()
    const malformed = adapter(() => ({
      connectorId: 'browser',
      state: 'connected',
      message: 'Verified.',
      grantedScopes: undefined as unknown as string[]
    }))
    manager.register(malformed)
    await expect(manager.verify('browser')).resolves.toMatchObject({ state: 'service-unavailable' })

    const invalidManager = new ConnectorManager()
    expect(() => invalidManager.register({
      ...adapter(() => ({ connectorId: 'browser', state: 'not-connected', message: 'Not connected.', grantedScopes: [] })),
      descriptor: {
        id: 'browser',
        name: 'Managed Browser',
        description: 'Description',
        capabilities: ['Open\npage'],
        requestedScopes: [],
        accessLevel: 'read-only'
      }
    })).toThrow(/capability is invalid/i)
  })
})
