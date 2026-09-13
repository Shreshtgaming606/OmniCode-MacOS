import { describe, expect, it } from 'vitest'

import type { ConnectorDescriptor } from '../../../shared/tool-contracts'
import { googleAccountSummary } from './google-account-status'

function connector(id: string, state: ConnectorDescriptor['status']['state'], message: string): ConnectorDescriptor {
  return {
    id,
    name: id,
    description: 'Test connector',
    capabilities: [],
    requestedScopes: [],
    accessLevel: 'ask-before-changes',
    status: { connectorId: id, state, message, grantedScopes: [] }
  }
}

describe('Google account display summary', () => {
  it('presents Gmail and Drive as service views over one connected account', () => {
    expect(googleAccountSummary([
      connector('gmail', 'connected', 'Connected as person@example.com.'),
      connector('google-drive', 'connected', 'Connected as person@example.com.')
    ])).toEqual({ state: 'connected', message: 'Connected as person@example.com.' })
  })

  it('uses an end-user not-connected message and preserves actionable failures', () => {
    expect(googleAccountSummary([
      connector('gmail', 'not-connected', 'Connect a Google account to continue.'),
      connector('google-drive', 'not-connected', 'Connect a Google account to continue.')
    ])).toEqual({
      state: 'not-connected',
      message: 'Not connected. Connect Gmail or Google Drive to authorize your Google account.'
    })
    expect(googleAccountSummary([
      connector('gmail', 'permission-missing', 'Reconnect person@example.com to grant the required permission.'),
      connector('google-drive', 'not-connected', 'Connect a Google account to continue.')
    ])).toMatchObject({ state: 'permission-missing' })
  })
})
