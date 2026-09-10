import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ConnectorConnectionState } from '../../shared/tool-contracts'
import { SecureItemNotFoundError, SecureKeychainStore } from './secure-keychain-store'

declare const __OMNICODE_GOOGLE_OAUTH_CLIENT_ID__: string
declare const __OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET__: string

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
const KEYCHAIN_ACCOUNT = 'google-workspace'
const CALLBACK_PATH = '/oauth2/callback'
const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000

export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const
export const GOOGLE_GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'] as const
export const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'] as const

export type GoogleWorkspaceService = 'gmail' | 'google-drive'

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret?: string
}

export interface GoogleAccountIdentity {
  subject: string
  email: string
  name?: string
  pictureUrl?: string
}

export interface GoogleServiceVerification {
  state: ConnectorConnectionState
  message: string
  checkedAt: string
  grantedScopes: string[]
  account?: GoogleAccountIdentity
}

interface GoogleTokenRecord {
  version: 1
  accessToken: string
  refreshToken?: string
  tokenType: 'Bearer'
  expiresAt: number
  scopes: string[]
  account: GoogleAccountIdentity
}

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  token_type?: unknown
  scope?: unknown
  error?: unknown
}

interface GoogleOAuthDependencies {
  fetch?: typeof fetch
  openExternal: (url: string) => Promise<unknown>
  now?: () => number
  randomBytes?: (size: number) => Buffer
  authorizationTimeoutMs?: number
}

class GoogleOAuthConfigurationError extends Error {
  constructor() {
    super('Google Workspace OAuth is not configured in this build. Add the registered desktop OAuth client before connecting.')
    this.name = 'GoogleOAuthConfigurationError'
  }
}

class GoogleOAuthHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Google OAuth request failed (${code || `HTTP ${status}`}).`)
    this.name = 'GoogleOAuthHttpError'
  }
}

class GoogleAuthenticationExpiredError extends Error {
  constructor() {
    super('Google authorization expired or was revoked. Reconnect the account.')
    this.name = 'GoogleAuthenticationExpiredError'
  }
}

function cleanConfigValue(value: string | undefined, label: string, maximum: number): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const normalized = value.trim()
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function buildTimeGoogleOAuthConfig(): GoogleOAuthConfig | undefined {
  const clientId = typeof __OMNICODE_GOOGLE_OAUTH_CLIENT_ID__ === 'string' ? __OMNICODE_GOOGLE_OAUTH_CLIENT_ID__ : ''
  const clientSecret = typeof __OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET__ === 'string' ? __OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET__ : ''
  return clientId ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : undefined
}

export function readGoogleOAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
  packagedConfig: GoogleOAuthConfig | undefined = buildTimeGoogleOAuthConfig()
): GoogleOAuthConfig | undefined {
  const runtimeClientId = cleanConfigValue(environment.OMNICODE_GOOGLE_OAUTH_CLIENT_ID, 'Google OAuth client ID', 512)
  const clientId = runtimeClientId ?? cleanConfigValue(packagedConfig?.clientId, 'Google OAuth client ID', 512)
  const clientSecret = cleanConfigValue(
    runtimeClientId ? environment.OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET : environment.OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET ?? packagedConfig?.clientSecret,
    'Google OAuth client secret',
    2_048
  )
  if (!clientId) return undefined
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(clientId)) {
    throw new Error('Google OAuth client ID is not a registered Google desktop client identifier.')
  }
  return { clientId, ...(clientSecret ? { clientSecret } : {}) }
}

export function scopesForGoogleService(service: GoogleWorkspaceService): readonly string[] {
  return service === 'gmail' ? GOOGLE_GMAIL_SCOPES : GOOGLE_DRIVE_SCOPES
}

function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort()
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function cleanToken(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Google returned an invalid ${label}.`)
  }
  return value
}

function parseIdentity(value: unknown): GoogleAccountIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Google returned invalid account information.')
  const candidate = value as Record<string, unknown>
  const subject = typeof candidate.sub === 'string' ? candidate.sub : ''
  const email = typeof candidate.email === 'string' ? candidate.email : ''
  const name = typeof candidate.name === 'string' ? candidate.name.slice(0, 200) : undefined
  const pictureUrl = typeof candidate.picture === 'string' && candidate.picture.startsWith('https://')
    ? candidate.picture.slice(0, 2_048)
    : undefined
  if (!subject || subject.length > 256 || !email || email.length > 320 || /[\r\n]/u.test(email)) {
    throw new Error('Google returned invalid account information.')
  }
  return { subject, email, ...(name ? { name } : {}), ...(pictureUrl ? { pictureUrl } : {}) }
}

function parseStoredRecord(serialized: string): GoogleTokenRecord {
  let value: unknown
  try { value = JSON.parse(serialized) } catch { throw new Error('The Google OAuth Keychain record is invalid. Reconnect the account.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The Google OAuth Keychain record is invalid. Reconnect the account.')
  const record = value as Partial<GoogleTokenRecord>
  const accessToken = cleanToken(record.accessToken, 'stored access token') as string
  const refreshToken = cleanToken(record.refreshToken, 'stored refresh token', false)
  if (record.version !== 1 || record.tokenType !== 'Bearer' || !Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) <= 0 || !Array.isArray(record.scopes)) {
    throw new Error('The Google OAuth Keychain record is invalid. Reconnect the account.')
  }
  if (record.scopes.some((scope) => typeof scope !== 'string' || !scope || scope.length > 500)) {
    throw new Error('The Google OAuth Keychain record is invalid. Reconnect the account.')
  }
  const rawAccount = record.account as unknown as Record<string, unknown> | undefined
  const account = parseIdentity(rawAccount
    ? { sub: rawAccount.subject, email: rawAccount.email, name: rawAccount.name, picture: rawAccount.pictureUrl }
    : undefined)
  return {
    version: 1,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    tokenType: 'Bearer',
    expiresAt: Number(record.expiresAt),
    scopes: uniqueScopes(record.scopes),
    account
  }
}

async function responseError(response: Response): Promise<GoogleOAuthHttpError> {
  let code = ''
  try {
    const value = await response.json() as { error?: unknown }
    if (typeof value?.error === 'string') code = value.error.replace(/[^A-Za-z0-9._-]/gu, '').slice(0, 80)
  } catch {
    // Never include arbitrary response bodies in OAuth errors or diagnostics.
  }
  return new GoogleOAuthHttpError(response.status, code)
}

function callbackPage(success: boolean): string {
  const heading = success ? 'Authorization received' : 'Google authorization was not completed'
  const detail = success ? 'Return to OmniCode while it securely verifies the account. This tab does not claim the connection succeeded.' : 'Return to OmniCode to review the connection status.'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>OmniCode</title><style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:#17191d;color:#f2f3f5;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:440px;padding:32px;border:1px solid #ffffff1f;border-radius:16px;background:#23262c;box-shadow:0 20px 60px #0008}h1{font-size:22px;margin:0 0 10px}p{color:#b8bdc7;line-height:1.5;margin:0}</style></head><body><main class="card"><h1>${heading}</h1><p>${detail}</p></main></body></html>`
}

async function openLoopbackCallback(
  expectedState: string,
  timeoutMs: number
): Promise<{ redirectUri: string; code: Promise<string>; close(): Promise<void> }> {
  let settleResolve: ((code: string) => void) | undefined
  let settleReject: ((error: Error) => void) | undefined
  let settled = false
  const code = new Promise<string>((resolve, reject) => { settleResolve = resolve; settleReject = reject })
  const settle = (error?: Error, value?: string): void => {
    if (settled) return
    settled = true
    if (error) settleReject?.(error)
    else settleResolve?.(value ?? '')
  }
  let timer: NodeJS.Timeout
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end('Not found')
      return
    }
    const state = requestUrl.searchParams.get('state') ?? ''
    if (!safeEqual(state, expectedState)) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(callbackPage(false))
      settle(new Error('Google OAuth state validation failed. No account was connected.'))
      return
    }
    const oauthError = requestUrl.searchParams.get('error')
    const authorizationCode = requestUrl.searchParams.get('code')
    const success = Boolean(authorizationCode && !oauthError)
    response.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(callbackPage(success))
    if (oauthError) settle(new Error(oauthError === 'access_denied' ? 'Google authorization was cancelled.' : 'Google did not authorize the requested access.'))
    else if (!authorizationCode || authorizationCode.length > 4_096) settle(new Error('Google returned an invalid authorization code.'))
    else settle(undefined, authorizationCode)
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address() as AddressInfo
  timer = setTimeout(() => settle(new Error('Google authorization timed out. Try connecting again.')), timeoutMs)
  timer.unref()
  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    code,
    close: async () => {
      clearTimeout(timer)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

export class GoogleOAuthManager {
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #randomBytes: (size: number) => Buffer
  readonly #authorizationTimeoutMs: number
  #connecting = false

  constructor(
    private readonly config: GoogleOAuthConfig | undefined,
    private readonly store: SecureKeychainStore,
    private readonly dependencies: GoogleOAuthDependencies
  ) {
    this.#fetch = dependencies.fetch ?? fetch
    this.#now = dependencies.now ?? Date.now
    this.#randomBytes = dependencies.randomBytes ?? randomBytes
    this.#authorizationTimeoutMs = dependencies.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS
  }

  isConfigured(): boolean { return Boolean(this.config?.clientId) }

  async connect(service: GoogleWorkspaceService): Promise<GoogleAccountIdentity> {
    if (this.#connecting) throw new Error('A Google account connection is already in progress.')
    this.#connecting = true
    try {
      return await this.#connect(service)
    } finally {
      this.#connecting = false
    }
  }

  async #connect(service: GoogleWorkspaceService): Promise<GoogleAccountIdentity> {
    const config = this.#requireConfig()
    const previous = await this.#loadOptional()
    const scopes = uniqueScopes([
      ...GOOGLE_IDENTITY_SCOPES,
      ...(previous?.scopes ?? []),
      ...scopesForGoogleService(service)
    ])
    const verifier = this.#randomBytes(64).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
    const state = this.#randomBytes(32).toString('base64url')
    const callback = await openLoopbackCallback(state, this.#authorizationTimeoutMs)
    try {
      const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT)
      authorizationUrl.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: callback.redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent'
      }).toString()
      await this.dependencies.openExternal(authorizationUrl.toString())
      const code = await callback.code
      const tokens = await this.#exchangeCode(code, verifier, callback.redirectUri)
      const account = await this.#fetchIdentity(tokens.accessToken)
      const refreshToken = tokens.refreshToken ?? (previous?.account.subject === account.subject ? previous.refreshToken : undefined)
      if (!refreshToken) throw new Error('Google did not return an offline refresh token. Reconnect and grant consent again.')
      await this.#save({
        version: 1,
        accessToken: tokens.accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresAt: this.#now() + tokens.expiresIn * 1_000,
        scopes: tokens.scopes.length ? tokens.scopes : scopes,
        account
      })
      return account
    } finally {
      await callback.close()
    }
  }

  async verify(service: GoogleWorkspaceService): Promise<GoogleServiceVerification> {
    const checkedAt = new Date(this.#now()).toISOString()
    const requiredScopes = scopesForGoogleService(service)
    try {
      const record = await this.#loadOptional()
      if (!record) {
        return {
          state: 'not-connected',
          message: this.isConfigured() ? 'Connect a Google account to continue.' : 'Google Workspace OAuth is not configured in this build.',
          checkedAt,
          grantedScopes: []
        }
      }
      if (requiredScopes.some((scope) => !record.scopes.includes(scope))) {
        return {
          state: 'permission-missing',
          message: `Reconnect ${record.account.email} to grant the required permission.`,
          checkedAt,
          grantedScopes: [...record.scopes],
          account: record.account
        }
      }
      const accessToken = await this.getAccessToken(requiredScopes)
      const account = await this.#fetchIdentity(accessToken)
      return {
        state: 'connected',
        message: `Connected as ${account.email}.`,
        checkedAt,
        grantedScopes: [...record.scopes],
        account
      }
    } catch (error) {
      const state = this.#stateForError(error)
      return {
        state,
        message: this.#messageForError(error, state),
        checkedAt,
        grantedScopes: []
      }
    }
  }

  async getAccessToken(requiredScopes: readonly string[]): Promise<string> {
    const record = await this.#load()
    if (requiredScopes.some((scope) => !record.scopes.includes(scope))) {
      throw new Error('The Google account has not granted the required permission.')
    }
    if (record.expiresAt > this.#now() + 60_000) return record.accessToken
    if (!record.refreshToken) throw new GoogleAuthenticationExpiredError()
    const config = this.#requireConfig()
    const body = new URLSearchParams({
      client_id: config.clientId,
      refresh_token: record.refreshToken,
      grant_type: 'refresh_token'
    })
    if (config.clientSecret) body.set('client_secret', config.clientSecret)
    const response = await this.#fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!response.ok) {
      const error = await responseError(response)
      if (error.code === 'invalid_grant' || error.status === 401) throw new GoogleAuthenticationExpiredError()
      throw error
    }
    const value = await response.json() as TokenResponse
    const accessToken = cleanToken(value.access_token, 'refreshed access token') as string
    const expiresIn = Number(value.expires_in)
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) throw new Error('Google returned an invalid access-token lifetime.')
    const refreshed: GoogleTokenRecord = {
      ...record,
      accessToken,
      expiresAt: this.#now() + expiresIn * 1_000,
      scopes: typeof value.scope === 'string' ? uniqueScopes(value.scope.split(/\s+/u)) : record.scopes
    }
    await this.#save(refreshed)
    return accessToken
  }

  async disconnect(): Promise<void> {
    const record = await this.#loadOptional()
    if (!record) {
      await this.store.delete(KEYCHAIN_ACCOUNT)
      return
    }
    const token = record.refreshToken ?? record.accessToken
    const response = await this.#fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token })
    })
    if (!response.ok && response.status !== 400) throw await responseError(response)
    await this.store.delete(KEYCHAIN_ACCOUNT)
  }

  async #exchangeCode(code: string, verifier: string, redirectUri: string): Promise<{
    accessToken: string
    refreshToken?: string
    expiresIn: number
    scopes: string[]
  }> {
    const config = this.#requireConfig()
    const body = new URLSearchParams({
      client_id: config.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
    if (config.clientSecret) body.set('client_secret', config.clientSecret)
    const response = await this.#fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!response.ok) throw await responseError(response)
    const value = await response.json() as TokenResponse
    const accessToken = cleanToken(value.access_token, 'access token') as string
    const refreshToken = cleanToken(value.refresh_token, 'refresh token', false)
    const expiresIn = Number(value.expires_in)
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400 || (value.token_type !== undefined && value.token_type !== 'Bearer')) {
      throw new Error('Google returned invalid OAuth token metadata.')
    }
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresIn,
      scopes: typeof value.scope === 'string' ? uniqueScopes(value.scope.split(/\s+/u)) : []
    }
  }

  async #fetchIdentity(accessToken: string): Promise<GoogleAccountIdentity> {
    const response = await this.#fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    })
    if (!response.ok) {
      if (response.status === 401) throw new GoogleAuthenticationExpiredError()
      throw await responseError(response)
    }
    return parseIdentity(await response.json())
  }

  async #loadOptional(): Promise<GoogleTokenRecord | undefined> {
    try { return parseStoredRecord(await this.store.get(KEYCHAIN_ACCOUNT)) }
    catch (error) {
      if (error instanceof SecureItemNotFoundError) return undefined
      throw error
    }
  }

  async #load(): Promise<GoogleTokenRecord> {
    const record = await this.#loadOptional()
    if (!record) throw new GoogleAuthenticationExpiredError()
    return record
  }

  #save(record: GoogleTokenRecord): Promise<void> {
    return this.store.set(KEYCHAIN_ACCOUNT, JSON.stringify(record))
  }

  #requireConfig(): GoogleOAuthConfig {
    if (!this.config) throw new GoogleOAuthConfigurationError()
    return this.config
  }

  #stateForError(error: unknown): ConnectorConnectionState {
    if (error instanceof GoogleAuthenticationExpiredError) return 'authentication-expired'
    if (error instanceof GoogleOAuthConfigurationError) return 'not-connected'
    if (error instanceof GoogleOAuthHttpError) {
      if (error.status === 401) return 'authentication-expired'
      if (error.status === 403) return 'permission-missing'
      if (error.status === 429) return 'rate-limited'
      if (error.status >= 500) return 'service-unavailable'
    }
    if (error instanceof TypeError) return 'network-error'
    return 'service-unavailable'
  }

  #messageForError(error: unknown, state: ConnectorConnectionState): string {
    if (error instanceof GoogleOAuthConfigurationError || error instanceof GoogleAuthenticationExpiredError || error instanceof GoogleOAuthHttpError) {
      return error.message
    }
    if (state === 'network-error') return 'Google could not be reached. Check the network and try again.'
    return 'Google connection verification failed. Reconnect the account or try again.'
  }
}
