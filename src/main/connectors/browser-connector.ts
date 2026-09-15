import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

import { BrowserWindow, session, type Session } from 'electron'

import type { ConnectorAdapter } from '../services/connector-manager'
import { ToolRegistry } from '../services/tool-registry'
import type { JsonValue } from '../../shared/tool-contracts'
import type { AppMode } from '../../shared/work-contracts'

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
  reload?(): Promise<BrowserPageSnapshot>
  click?(selector: string): Promise<{ clicked: boolean; description: string }>
  typeText?(selector: string, text: string): Promise<{ typed: boolean; description: string }>
  consoleErrors?(): Promise<string[]>
  show(): void
  destroy(): void
  clearStorage(): Promise<void>
}

export interface BrowserConnectorOptions {
  createPage?: () => Promise<ManagedBrowserPage>
  resolveHost?: (hostname: string) => Promise<string[]>
  mode?: AppMode
  allowLoopback?: boolean
  connectorId?: string
  shouldShow?(executionId?: string): boolean
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

function loopbackHostname(hostname: string): boolean {
  const unwrapped = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return unwrapped === 'localhost' || unwrapped.endsWith('.localhost') || unwrapped === '127.0.0.1' || unwrapped === '::1'
}

function validateManagedBrowserUrl(value: string, allowLoopback: boolean): URL {
  if (typeof value !== 'string' || value.length > 2_048 || /[\0\r\n]/u.test(value)) throw new Error('Enter a valid secure web address.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Enter a valid secure web address.') }
  const hostname = url.hostname.toLowerCase()
  const isLoopback = loopbackHostname(hostname)
  if (url.protocol !== 'https:' && !(allowLoopback && isLoopback && url.protocol === 'http:')) {
    throw new Error(allowLoopback ? 'The managed Code browser opens HTTPS pages and loopback HTTP pages only.' : 'The managed Work browser opens HTTPS pages only.')
  }
  if (url.username || url.password) throw new Error('Browser addresses cannot contain usernames or passwords.')
  const unwrappedHostname = hostname.replace(/^\[|\]$/gu, '')
  if (!hostname || (!allowLoopback && isLoopback) || (isIP(unwrappedHostname) && isPrivateNetworkAddress(unwrappedHostname) && !(allowLoopback && isLoopback))) {
    throw new Error('The managed Work browser cannot access this local or private-network address.')
  }
  return url
}

export function validateBrowserUrl(value: string): URL {
  return validateManagedBrowserUrl(value, false)
}

export function validateCodeBrowserUrl(value: string): URL {
  return validateManagedBrowserUrl(value, true)
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
  readonly #consoleErrors: string[] = []

  constructor(private readonly window: BrowserWindow, private readonly isolatedSession: Session, private readonly allowLoopback: boolean) {
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level < 2) return
      const clean = `${message} (${sourceId || 'page'}:${line})`.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_000)
      this.#consoleErrors.push(clean)
      if (this.#consoleErrors.length > 100) this.#consoleErrors.shift()
    })
  }

  isDestroyed(): boolean { return this.window.isDestroyed() }

  async loadURL(url: string): Promise<void> {
    await this.window.loadURL(url)
  }

  async snapshot(): Promise<BrowserPageSnapshot> {
    const snapshot = await this.window.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true)
    if (!this.allowLoopback) return sanitizeSnapshot(snapshot)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('The managed browser returned an invalid page snapshot.')
    const value = snapshot as Partial<BrowserPageSnapshot>
    if (typeof value.title !== 'string' || typeof value.url !== 'string' || typeof value.text !== 'string') throw new Error('The managed browser returned an invalid page snapshot.')
    return { title: value.title.slice(0, 1_000), url: validateCodeBrowserUrl(value.url).toString(), text: value.text.slice(0, MAX_PAGE_TEXT) }
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

  async reload(): Promise<BrowserPageSnapshot> {
    this.window.webContents.reload()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The managed browser reload timed out.')), 15_000)
      this.window.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve() })
      this.window.webContents.once('did-fail-load', (_event, _code, description) => { clearTimeout(timeout); reject(new Error(description)) })
    })
    return this.snapshot()
  }

  async click(selector: string): Promise<{ clicked: boolean; description: string }> {
    const source = JSON.stringify(selector)
    const result = await this.window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${source})
      if (!(element instanceof HTMLElement)) return { clicked: false, description: 'No matching element.' }
      const tag = element.tagName.toLowerCase()
      const type = String(element.getAttribute('type') || '').toLowerCase()
      const label = String(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || tag).trim().slice(0, 300)
      if (element.closest('form') || type === 'submit' || type === 'password' || /pay|purchase|delete|remove|sign.?in|log.?in|account|security/i.test(label)) {
        throw new Error('The managed browser blocked a form, account, destructive, or financial control.')
      }
      element.click()
      return { clicked: true, description: label || tag }
    })()`, true) as { clicked?: unknown; description?: unknown }
    if (typeof result?.clicked !== 'boolean' || typeof result?.description !== 'string') throw new Error('The managed browser returned an invalid click result.')
    return { clicked: result.clicked, description: result.description.slice(0, 300) }
  }

  async typeText(selector: string, text: string): Promise<{ typed: boolean; description: string }> {
    const selectorSource = JSON.stringify(selector)
    const textSource = JSON.stringify(text)
    const result = await this.window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${selectorSource})
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return { typed: false, description: 'No matching text field.' }
      if (element.type === 'password' || /password|secret|token|api.?key|credential/i.test(String(element.name || element.id || element.getAttribute('aria-label') || ''))) {
        throw new Error('The managed browser never types into credential fields.')
      }
      element.focus()
      element.value = ${textSource}
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { typed: true, description: String(element.getAttribute('aria-label') || element.name || element.id || 'text field').slice(0, 300) }
    })()`, true) as { typed?: unknown; description?: unknown }
    if (typeof result?.typed !== 'boolean' || typeof result?.description !== 'string') throw new Error('The managed browser returned an invalid typing result.')
    return { typed: result.typed, description: result.description.slice(0, 300) }
  }

  async consoleErrors(): Promise<string[]> { return [...this.#consoleErrors] }

  show(): void { this.window.show(); this.window.focus() }
  destroy(): void { if (!this.window.isDestroyed()) this.window.destroy() }
  clearStorage(): Promise<void> { return this.isolatedSession.clearStorageData() }
}

function installSessionGuards(
  isolatedSession: Session,
  resolveHost: (hostname: string) => Promise<string[]>,
  allowLoopback: boolean
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
        validateManagedBrowserUrl(url.toString(), allowLoopback)
        if (allowLoopback && loopbackHostname(url.hostname)) return callback({ cancel: false })
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

async function createElectronPage(resolveHost: (hostname: string) => Promise<string[]>, mode: AppMode, allowLoopback: boolean): Promise<ManagedBrowserPage> {
  const isolatedSession = session.fromPartition(`persist:omnicode-${mode}-browser-v1`, { cache: true })
  installSessionGuards(isolatedSession, resolveHost, allowLoopback)
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: `OmniCode ${mode === 'code' ? 'Code' : 'Work'} Browser`,
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
    try { validateManagedBrowserUrl(target, allowLoopback) } catch { event.preventDefault() }
  })
  await window.loadURL('about:blank')
  return new ElectronManagedBrowserPage(window, isolatedSession, allowLoopback)
}

export class BrowserConnector implements ConnectorAdapter {
  readonly descriptor: ConnectorAdapter['descriptor']

  readonly #createPage: () => Promise<ManagedBrowserPage>
  readonly #resolveHost: (hostname: string) => Promise<string[]>
  readonly #mode: AppMode
  readonly #allowLoopback: boolean
  readonly #shouldShow: (executionId?: string) => boolean
  #page: ManagedBrowserPage | null = null

  constructor(options: BrowserConnectorOptions = {}) {
    this.#mode = options.mode ?? 'work'
    this.#allowLoopback = options.allowLoopback ?? false
    this.#shouldShow = options.shouldShow ?? (() => true)
    this.descriptor = {
      id: options.connectorId ?? (this.#mode === 'code' ? 'code-browser' : 'browser'),
      name: this.#mode === 'code' ? 'Code Browser' : 'Managed Browser',
      description: `A dedicated, isolated browser session for approved ${this.#mode === 'code' ? 'Code' : 'Work'} tasks.`,
      capabilities: this.#mode === 'code' ? ['Open documentation and localhost pages', 'Read visible page', 'Find text', 'Inspect console errors'] : ['Open secure pages', 'Read visible page', 'Find text'],
      requestedScopes: [],
      accessLevel: 'read-only' as const
    }
    this.#resolveHost = options.resolveHost ?? defaultResolveHost
    this.#createPage = options.createPage ?? (() => createElectronPage(this.#resolveHost, this.#mode, this.#allowLoopback))
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

  async open(urlValue: string, show = true): Promise<BrowserPageSnapshot> {
    const page = this.#requirePage()
    const url = validateManagedBrowserUrl(urlValue, this.#allowLoopback)
    if (!(this.#allowLoopback && loopbackHostname(url.hostname))) await publicAddresses(url.hostname, this.#resolveHost)
    await page.loadURL(url.toString())
    if (show) page.show()
    return page.snapshot()
  }

  async searchWeb(queryValue: string, show = true): Promise<BrowserPageSnapshot> {
    const query = queryValue.trim()
    if (!query || query.length > 500 || /[\0\r\n]/u.test(query)) throw new Error('Enter a valid web search no longer than 500 characters.')
    const searchUrl = new URL('https://www.google.com/search')
    searchUrl.searchParams.set('q', query)
    return this.open(searchUrl.toString(), show)
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
    const readSafety = { category: 'read' as const, risk: 'low' as const, reversible: true, externalSideEffect: false }
    registry.register({
      id: 'browser.open', name: 'Open web page', description: 'Open and read a secure public page in the managed browser.',
      connectorId: this.descriptor.id, modes: [this.#mode], action: 'read', ...readSafety, confirmation: 'never', requiredScopes: [],
      inputSchema: { type: 'object', properties: { url: { type: 'string', maxLength: 2_048 } }, required: ['url'], additionalProperties: false },
      resultSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 1_000 }, url: { type: 'string', maxLength: 2_048 }, text: { type: 'string', maxLength: MAX_PAGE_TEXT } }, required: ['title', 'url', 'text'], additionalProperties: false }
    }, async (input, context) => {
      await this.connect()
      const snapshot = await this.open(String(input.url), this.#shouldShow(context.executionId))
      return { title: snapshot.title, url: snapshot.url, text: snapshot.text } satisfies Record<string, JsonValue>
    })
    registry.register({
      id: 'browser.read', name: 'Read visible page', description: 'Read the title, URL, and visible text from the managed browser.',
      connectorId: this.descriptor.id, modes: [this.#mode], action: 'read', ...readSafety, confirmation: 'never', requiredScopes: [],
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      resultSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 1_000 }, url: { type: 'string', maxLength: 2_048 }, text: { type: 'string', maxLength: MAX_PAGE_TEXT } }, required: ['title', 'url', 'text'], additionalProperties: false }
    }, async () => {
      const snapshot = await this.readVisiblePage()
      return { title: snapshot.title, url: snapshot.url, text: snapshot.text } satisfies Record<string, JsonValue>
    })
    registry.register({
      id: 'browser.find', name: 'Find text on page', description: 'Find visible lines containing text on the current managed page.',
      connectorId: this.descriptor.id, modes: [this.#mode], action: 'read', ...readSafety, confirmation: 'never', requiredScopes: [],
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['query'], additionalProperties: false },
      resultSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0 }, excerpts: { type: 'array', items: { type: 'string', maxLength: 1_000 }, maxItems: MAX_FIND_RESULTS } }, required: ['count', 'excerpts'], additionalProperties: false }
    }, async (input) => this.findText(String(input.query)))
    if (this.#mode === 'code') {
      registry.register({
        id: 'browser.search', name: 'Search the web', description: 'Search the public web for technical documentation in the managed Code Browser.',
        connectorId: this.descriptor.id, modes: ['code'], action: 'read', ...readSafety, confirmation: 'never', requiredScopes: [],
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['query'], additionalProperties: false },
        resultSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 1_000 }, url: { type: 'string', maxLength: 2_048 }, text: { type: 'string', maxLength: MAX_PAGE_TEXT } }, required: ['title', 'url', 'text'], additionalProperties: false }
      }, async (input, context) => {
        await this.connect()
        const snapshot = await this.searchWeb(String(input.query), this.#shouldShow(context.executionId))
        return { title: snapshot.title, url: snapshot.url, text: snapshot.text } satisfies Record<string, JsonValue>
      })
      registry.register({
        id: 'browser.reload', name: 'Reload page', description: 'Reload the current Code Browser page and return its visible contents.',
        connectorId: this.descriptor.id, modes: ['code'], action: 'read', ...readSafety, confirmation: 'never', requiredScopes: [],
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, maxResultBytes: 256 * 1024
      }, async () => (await (this.#requirePage().reload?.() ?? Promise.reject(new Error('Browser reload is unavailable.')))) as unknown as JsonValue)
      registry.register({
        id: 'browser.console', name: 'Read browser errors', description: 'Read bounded error and warning messages from the Code Browser console.',
        connectorId: this.descriptor.id, modes: ['code'], action: 'read', ...readSafety, confirmation: 'never', requiredScopes: [],
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, maxResultBytes: 64 * 1024
      }, async () => ({ errors: await (this.#requirePage().consoleErrors?.() ?? Promise.resolve([])) }))
      const interactionSafety = { category: 'external-submission' as const, risk: 'medium' as const, reversible: true, externalSideEffect: true }
      registry.register({
        id: 'browser.click', name: 'Click page control', description: 'Click one non-form, non-account, non-destructive page element by CSS selector.',
        connectorId: this.descriptor.id, modes: ['code'], action: 'write', ...interactionSafety, confirmation: 'policy', requiredScopes: [],
        inputSchema: { type: 'object', properties: { selector: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['selector'], additionalProperties: false }
      }, async (input) => this.#requirePage().click?.(String(input.selector)) ?? Promise.reject(new Error('Browser clicking is unavailable.')))
      registry.register({
        id: 'browser.type', name: 'Type into page', description: 'Type non-secret text into one non-password field without submitting a form.',
        connectorId: this.descriptor.id, modes: ['code'], action: 'write', ...interactionSafety, confirmation: 'policy', requiredScopes: [],
        inputSchema: { type: 'object', properties: { selector: { type: 'string', minLength: 1, maxLength: 500 }, text: { type: 'string', maxLength: 8_000 } }, required: ['selector', 'text'], additionalProperties: false }
      }, async (input) => this.#requirePage().typeText?.(String(input.selector), String(input.text)) ?? Promise.reject(new Error('Browser typing is unavailable.')))
    }
  }

  #requirePage(): ManagedBrowserPage {
    if (!this.#page || this.#page.isDestroyed()) throw new Error('Connect the Managed Browser before using browser tools.')
    return this.#page
  }
}
