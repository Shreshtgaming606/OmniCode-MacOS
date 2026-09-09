import type {
  ConnectorConnectionState,
  ConnectorDescriptor,
  ConnectorStatus
} from '../../shared/tool-contracts'

const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u
const CONNECTION_STATES = new Set<ConnectorConnectionState>([
  'not-connected',
  'connecting',
  'connected',
  'authentication-expired',
  'permission-missing',
  'network-error',
  'rate-limited',
  'service-unavailable'
])

export interface ConnectorAdapter {
  readonly descriptor: Omit<ConnectorDescriptor, 'status'>
  connect(): Promise<void>
  verify(): Promise<ConnectorStatus>
  disconnect(): Promise<void>
}

interface ConnectorEntry {
  adapter: ConnectorAdapter
  descriptor: Omit<ConnectorDescriptor, 'status'>
  status: ConnectorStatus
  operation: Promise<void>
}

function cleanText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`${label} is invalid.`)
  return normalized
}

function safeConnectorError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer ••••')
    .replace(/\b(authorization|proxy-authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/giu, '$1: ••••')
    .replace(/([?&](?:key|api_key|access_token|refresh_token|token|client_secret)=)[^&#\s]+/giu, '$1••••')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, 800) || 'Unknown connector error.'
}

function cleanList(value: unknown, label: string, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} is invalid.`)
  return [...new Set(value.map((item) => cleanText(item, label, 200)))]
}

function normalizeDescriptor(descriptor: Omit<ConnectorDescriptor, 'status'>): Omit<ConnectorDescriptor, 'status'> {
  if (!descriptor || !CONNECTOR_ID_PATTERN.test(descriptor.id)) throw new Error('Connector IDs contain unsupported characters.')
  if (!['read-only', 'ask-before-changes', 'trusted'].includes(descriptor.accessLevel)) throw new Error('Connector access level is invalid.')
  return Object.freeze({
    id: descriptor.id,
    name: cleanText(descriptor.name, 'Connector name', 120),
    description: cleanText(descriptor.description, 'Connector description', 1_000),
    capabilities: Object.freeze(cleanList(descriptor.capabilities, 'Connector capability', 100)),
    requestedScopes: Object.freeze(cleanList(descriptor.requestedScopes, 'Connector scope', 100)),
    accessLevel: descriptor.accessLevel
  })
}

function initialStatus(connectorId: string): ConnectorStatus {
  return {
    connectorId,
    state: 'not-connected',
    message: 'Not connected.',
    grantedScopes: []
  }
}

function validateStatus(connectorId: string, status: ConnectorStatus): ConnectorStatus {
  if (!status || status.connectorId !== connectorId || !CONNECTION_STATES.has(status.state)) {
    throw new Error(`Connector ${connectorId} returned an invalid connection status.`)
  }
  let checkedAt: string | undefined
  if (status.checkedAt !== undefined) {
    const raw = cleanText(status.checkedAt, 'Connector check time', 64)
    const timestamp = Date.parse(raw)
    if (!Number.isFinite(timestamp)) throw new Error('Connector check time is invalid.')
    checkedAt = new Date(timestamp).toISOString()
  }
  return {
    connectorId,
    state: status.state,
    message: safeConnectorError(cleanText(status.message, 'Connector status message', 1_000)),
    checkedAt,
    grantedScopes: cleanList(status.grantedScopes, 'Connector scope', 100)
  }
}

function copyStatus(status: ConnectorStatus): ConnectorStatus {
  return { ...status, grantedScopes: [...status.grantedScopes] }
}

function unavailableStatus(connectorId: string, operation: string, error: unknown): ConnectorStatus {
  return {
    connectorId,
    state: 'service-unavailable',
    message: `${operation} failed: ${safeConnectorError(error)}`,
    checkedAt: new Date().toISOString(),
    grantedScopes: []
  }
}

export class ConnectorManager {
  readonly #connectors = new Map<string, ConnectorEntry>()

  register(adapter: ConnectorAdapter): void {
    if (!adapter || typeof adapter.connect !== 'function' || typeof adapter.verify !== 'function' || typeof adapter.disconnect !== 'function') {
      throw new Error('Connector adapter is invalid.')
    }
    const descriptor = normalizeDescriptor(adapter.descriptor)
    if (this.#connectors.has(descriptor.id)) throw new Error(`Connector ${descriptor.id} is already registered.`)
    this.#connectors.set(descriptor.id, {
      adapter,
      descriptor,
      status: initialStatus(descriptor.id),
      operation: Promise.resolve()
    })
  }

  async list(refresh = false): Promise<ConnectorDescriptor[]> {
    if (refresh) await Promise.all([...this.#connectors.keys()].map((id) => this.verify(id)))
    return [...this.#connectors.values()].map(({ descriptor, status }) => ({
      ...descriptor,
      capabilities: [...descriptor.capabilities],
      requestedScopes: [...descriptor.requestedScopes],
      status: copyStatus(status)
    }))
  }

  async verify(id: string): Promise<ConnectorStatus> {
    const entry = this.#entry(id)
    return this.#enqueue(entry, () => this.#verifyEntry(entry))
  }

  async connect(id: string): Promise<ConnectorStatus> {
    const entry = this.#entry(id)
    return this.#enqueue(entry, async () => {
      entry.status = { connectorId: id, state: 'connecting', message: 'Connecting…', grantedScopes: [] }
      try {
        await entry.adapter.connect()
      } catch (error) {
        entry.status = unavailableStatus(id, 'Connection', error)
        return copyStatus(entry.status)
      }
      return this.#verifyEntry(entry)
    })
  }

  async disconnect(id: string): Promise<ConnectorStatus> {
    const entry = this.#entry(id)
    return this.#enqueue(entry, async () => {
      try {
        await entry.adapter.disconnect()
      } catch (error) {
        entry.status = unavailableStatus(id, 'Disconnect', error)
        return copyStatus(entry.status)
      }
      const verified = await this.#verifyEntry(entry)
      if (verified.state === 'connected') throw new Error(`${entry.descriptor.name} remained connected after disconnect.`)
      return verified
    })
  }

  status(id: string): ConnectorStatus {
    const status = this.#entry(id).status
    return copyStatus(status)
  }

  async #verifyEntry(entry: ConnectorEntry): Promise<ConnectorStatus> {
    try {
      entry.status = validateStatus(entry.descriptor.id, await entry.adapter.verify())
    } catch (error) {
      entry.status = unavailableStatus(entry.descriptor.id, 'Connection verification', error)
    }
    return copyStatus(entry.status)
  }

  #enqueue<T>(entry: ConnectorEntry, operation: () => Promise<T>): Promise<T> {
    const result = entry.operation.then(operation, operation)
    entry.operation = result.then(() => undefined, () => undefined)
    return result
  }

  #entry(id: string): ConnectorEntry {
    if (typeof id !== 'string' || !CONNECTOR_ID_PATTERN.test(id)) throw new Error('Choose a valid connector.')
    const entry = this.#connectors.get(id)
    if (!entry) throw new Error('The requested connector is not registered.')
    return entry
  }
}
