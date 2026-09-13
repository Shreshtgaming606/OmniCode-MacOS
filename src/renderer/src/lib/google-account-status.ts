import type { ConnectorConnectionState, ConnectorDescriptor } from '../../../shared/tool-contracts'

const GOOGLE_CONNECTOR_IDS = new Set(['gmail', 'google-drive'])

export interface GoogleAccountSummary {
  state: ConnectorConnectionState
  message: string
}

/**
 * Gmail and Drive are service views over one shared Google authorization. This
 * display summary intentionally derives only from sanitized connector status;
 * OAuth configuration and tokens never cross into the renderer.
 */
export function googleAccountSummary(connectors: readonly ConnectorDescriptor[]): GoogleAccountSummary | undefined {
  const google = connectors.filter((connector) => GOOGLE_CONNECTOR_IDS.has(connector.id))
  if (!google.length) return undefined
  const connected = google.find((connector) => connector.status.state === 'connected')
  if (connected) return { state: 'connected', message: connected.status.message }
  const priority: ConnectorConnectionState[] = [
    'connecting',
    'authentication-expired',
    'permission-missing',
    'network-error',
    'rate-limited',
    'service-unavailable'
  ]
  for (const state of priority) {
    const match = google.find((connector) => connector.status.state === state)
    if (match) return { state, message: match.status.message }
  }
  return { state: 'not-connected', message: 'Not connected. Connect Gmail or Google Drive to authorize your Google account.' }
}
