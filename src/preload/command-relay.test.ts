import { describe, expect, it, vi } from 'vitest'

import { createAppCommandRelay } from './command-relay'

describe('app command relay', () => {
  it('delivers commands queued before the renderer subscribes in order', () => {
    const relay = createAppCommandRelay()
    const listener = vi.fn()
    relay.dispatch('setup-tools')
    relay.dispatch('open-path', { path: '/tmp/project', kind: 'directory' })

    relay.subscribe(listener)

    expect(listener.mock.calls).toEqual([
      ['setup-tools', undefined],
      ['open-path', { path: '/tmp/project', kind: 'directory' }]
    ])
  })

  it('delivers later commands immediately and stops after unsubscribe', () => {
    const relay = createAppCommandRelay()
    const listener = vi.fn()
    const unsubscribe = relay.subscribe(listener)
    relay.dispatch('settings', true)
    unsubscribe()
    relay.dispatch('help')

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith('settings', true)
  })

  it('bounds the startup queue and keeps the newest commands', () => {
    const relay = createAppCommandRelay(2)
    const listener = vi.fn()
    relay.dispatch('oldest')
    relay.dispatch('middle')
    relay.dispatch('newest')
    relay.subscribe(listener)

    expect(listener.mock.calls.map(([command]) => command)).toEqual(['middle', 'newest'])
  })
})
