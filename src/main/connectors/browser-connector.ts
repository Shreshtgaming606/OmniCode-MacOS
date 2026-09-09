import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

import { BrowserWindow, session, type Session } from 'electron'

import type { ConnectorAdapter } from '../services/connector-manager'
import { ToolRegistry } from '../services/tool-registry'
import type { JsonValue } from '../../shared/tool-contracts'

const MAX_PAGE_TEXT = 128 * 1024
const MAX_FIND_RESULTS = 100
const DNS_GUARD_TIMEOUT_MS = 5_000
const DNS_GUARD_CACHE_MS = 60_000
const SNAPSHOT_SCRIPT = `(() => ({
  title: String(document.title || '').slice(0, 1000),
  url: String(location.href),
  text: String(document.body?.innerText || '').slice(0, ${MAX_PAGE_TEXT})
}))()`

export interface BrowserPageSnapshot {
  title: string
  url: string
  text: string
}

export interface ManagedBrowserPage {
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  snapshot(): Promise<BrowserPageSnapshot>
  findText(query: string): Promise<{ count: number; excerpts: string[] }>
  show(): void
  destroy(): void
  clearStorage(): Promise<void>
}

export interface BrowserConnectorOptions {
  createPage?: () => Promise<ManagedBrowserPage>
  resolveHost?: (hostname: string) => Promise<string[]>
}

function privateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [first, second, third] = parts
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113)
}

function privateIPv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, '')
  const mappedIPv4 = normalized.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1]
  if (mappedIPv4) return privateIPv4(mappedIPv4)
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || /^fe[89ab]/u.test(normalized) || normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
}

export function isPrivateNetworkAddress(address: string): boolean {
  const version = isIP(address.replace(/^\[|\]$/gu, ''))
  return version === 4 ? privateIPv4(address) : version === 6 ? privateIPv6(address) : true
}

export function validateBrowserUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2_048 || /[\0\r\n]/u.test(value)) throw new Error('Enter a valid secure web address.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Enter a valid secure web address.') }
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:') throw new Error('The managed Work browser opens HTTPS pages only.')
  if (url.username || url.password) throw new Error('Browser addresses cannot contain usernames or passwords.')
  const unwrappedHostname = hostname.replace(/^\[|\]$/gu, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || (isIP(unwrappedHostname) && isPrivateNetworkAddress(unwrappedHostname))) {
    throw new Error('The managed Work browser cannot access this local or private-network address.')
  }
  return url
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const unwrappedHostname = hostname.replace(/^\[|\]$/gu, '')
  if (isIP(unwrappedHostname)) return [unwrappedHostname]
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

async function publicAddresses(
  hostname: string,
  resolveHost: (hostname: string) => Promise<string[]>
): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined
  try {
    const addresses = await Promise.race([
      resolveHost(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DNS safety check timed out.')), DNS_GUARD_TIMEOUT_MS)
      })
    ])
    if (!addresses.length || addresses.some(isPrivateNetworkAddress)) {
      throw new Error('The managed Work browser blocked a private-network or unresolved destination.')
    }
    return addresses
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sanitizeSnapshot(value: unknown): BrowserPageSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The managed browser returned an invalid page snapshot.')
  const snapshot = value as Partial<BrowserPageSnapshot>
  if (typeof snapshot.title !== 'string' || typeof snapshot.url !== 'string' || typeof snapshot.text !== 'string') {
    throw new Error('The managed browser returned an invalid page snapshot.')
  }
  const url = validateBrowserUrl(snapshot.url)
  return { title: snapshot.title.slice(0, 1_000), url: url.toString(), text: snapshot.text.slice(0, MAX_PAGE_TEXT) }
}

class ElectronManagedBrowserPage implements ManagedBrowserPage {
  constructor(private readonly window: BrowserWindow, private readonly isolatedSession: Session) {}

  isDestroyed(): boolean { return this.window.isDestroyed() }

  async loadURL(url: string): Promise<void> {
    await this.window.loadURL(url)
  }

  async snapshot(): Promise<BrowserPageSnapshot> {
    return sanitizeSnapshot(await this.window.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true))
  }

  async findText(query: string): Promise<{ count: number; excerpts: string[] }> {
    const source = JSON.stringify(query)
    const value = await this.window.webContents.executeJavaScript(`(() => {
      const query = ${source}.toLocaleLowerCase()
      const lines = String(document.body?.innerText || '').split(/\\n+/u).map((line) => line.trim()).filter(Boolean)
      const matches = lines.filter((line) => line.toLocaleLowerCase().includes(query))
      return { count: matches.length, excerpts: matches.slice(0, ${MAX_FIND_RESULTS}).map((line) => line.slice(0, 1000)) }
    })()`, true) as { count?: unknown; excerpts?: unknown }
    if (!Number.isSafeInteger(value?.count) || Number(value.count) < 0 || !Array.isArray(value?.excerpts) || value.excerpts.some((item) => typeof item !== 'string')) {
      throw new Error('The managed browser returned invalid search results.')
    }
    return { count: Number(value.count), excerpts: value.excerpts.slice(0, MAX_FIND_RESULTS) as string[] }
  }

  show(): void { this.window.show(); this.window.focus() }
  destroy(): void { if (!this.window.isDestroyed()) this.window.destroy() }
  clearStorage(): Promise<void> { return this.isolatedSession.clearStorageData() }
}

function installSessionGuards(
  isolatedSession: Session,
  resolveHost: (hostname: string) => Promise<string[]>
): void {
  const publicHostCache = new Map<string, number>()
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  isolatedSession.setPermissionCheckHandler(() => false)
  isolatedSession.on('will-download', (event) => event.preventDefault())
  isolatedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    void (async () => {
      try {
        const url = new URL(details.url)
        if (url.protocol === 'about:' && url.toString() === 'about:blank') return callback({ cancel: false })
        validateBrowserUrl(url.toString())
        const cachedUntil = publicHostCache.get(url.hostname) ?? 0
        if (cachedUntil <= Date.now()) {
          await publicAddresses(url.hostname, resolveHost)
          publicHostCache.set(url.hostname, Date.now() + DNS_GUARD_CACHE_MS)
        }
        callback({ cancel: false })
      } catch {
        callback({ cancel: true })
      }
    })()
  })
}

async function createElectronPage(resolveHost: (hostname: string) => Promise<string[]>): Promise<ManagedBrowserPage> {
  const isolatedSession = session.fromPartition('persist:omnicode-work-browser-v1', { cache: true })
  installSessionGuards(isolatedSession, resolveHost)
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'OmniCode Work Browser',
    webPreferences: {
      session: isolatedSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    try { validateBrowserUrl(target) } catch { event.preventDefault() }
  })
  await window.loadURL('about:blank')
  return new ElectronManagedBrowserPage(window, isolatedSession)
}

export class BrowserConnector implements ConnectorAdapter {
  readonly descriptor = {
    id: 'browser',
    name: 'Managed Browser',
    description: 'A dedicated, isolated browser session for approved Work tasks.',
    capabilities: ['Open secure pages', 'Read visible page', 'Find text'],
    requestedScopes: [],
    accessLevel: 'read-only' as const
  }

  readonly #createPage: () => Promise<ManagedBrowserPage>
  readonly #resolveHost: (hostname: string) => Promise<string[]>
  #page: ManagedBrowserPage | null = null

  constructor(options: BrowserConnectorOptions = {}) {
    this.#resolveHost = options.resolveHost ?? defaultResolveHost
    this.#createPage = options.createPage ?? (() => createElectronPage(this.#resolveHost))
  }

  async connect(): Promise<void> {
    if (this.#page && !this.#page.isDestroyed()) return
    this.#page = await this.#createPage()
  }

  async verify() {
    const connected = Boolean(this.#page && !this.#page.isDestroyed())
    return {
      connectorId: this.descriptor.id,
      state: connected ? 'connected' as const : 'not-connected' as const,
      message: connected ? 'The isolated Work browser is ready.' : 'The managed browser is not running.',
      checkedAt: new Date().toISOString(),
      grantedScopes: []
    }
  }

  async disconnect(): Promise<void> {
    const page = this.#page
    this.#page = null
    if (!page) return
    page.destroy()
    await page.clearStorage()
  }

  async open(urlValue: string): Promise<BrowserPageSnapshot> {
    const page = this.#requirePage()
    const url = validateBrowserUrl(urlValue)
    await publicAddresses(url.hostname, this.#resolveHost)
    await page.loadURL(url.toString())
    page.show()
    return page.snapshot()
  }

  readVisiblePage(): Promise<BrowserPageSnapshot> {
    return this.#requirePage().snapshot()
  }

  findText(query: string): Promise<{ count: number; excerpts: string[] }> {
    const normalized = query.trim()
    if (!normalized || normalized.length > 500 || /[\0\r\n]/u.test(normalized)) throw new Error('Enter a valid page search no longer than 500 characters.')
    return this.#requirePage().findText(normalized)
  }

  registerTools(registry: ToolRegistry): void {
    registry.register({
      id: 'browser.open', name: 'Open web page', description: 'Open and read a secure public page in the managed browser.',
      connectorId: 'browser', modes: ['work'], action: 'read', confirmation: 'never', requiredScopes: [],
      inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'https-url', maxLength: 2_048 } }, required: ['url'], additionalProperties: false },
      resultSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 1_000 }, url: { type: 'string', format: 'https-url', maxLength: 2_048 }, text: { type: 'string', maxLength: MAX_PAGE_TEXT } }, required: ['title', 'url', 'text'], additionalProperties: false }
    }, async (input) => {
      const snapshot = await this.open(String(input.url))
      return { title: snapshot.title, url: snapshot.url, text: snapshot.text } satisfies Record<string, JsonValue>
    })
    registry.register({
      id: 'browser.read', name: 'Read visible page', description: 'Read the title, URL, and visible text from the managed browser.',
      connectorId: 'browser', modes: ['work'], action: 'read', confirmation: 'never', requiredScopes: [],
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      resultSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 1_000 }, url: { type: 'string', format: 'https-url', maxLength: 2_048 }, text: { type: 'string', maxLength: MAX_PAGE_TEXT } }, required: ['title', 'url', 'text'], additionalProperties: false }
    }, async () => {
      const snapshot = await this.readVisiblePage()
      return { title: snapshot.title, url: snapshot.url, text: snapshot.text } satisfies Record<string, JsonValue>
    })
    registry.register({
      id: 'browser.find', name: 'Find text on page', description: 'Find visible lines containing text on the current managed page.',
      connectorId: 'browser', modes: ['work'], action: 'read', confirmation: 'never', requiredScopes: [],
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['query'], additionalProperties: false },
      resultSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0 }, excerpts: { type: 'array', items: { type: 'string', maxLength: 1_000 }, maxItems: MAX_FIND_RESULTS } }, required: ['count', 'excerpts'], additionalProperties: false }
    }, async (input) => this.findText(String(input.query)))
  }

  #requirePage(): ManagedBrowserPage {
    if (!this.#page || this.#page.isDestroyed()) throw new Error('Connect the Managed Browser before using browser tools.')
    return this.#page
  }
}
