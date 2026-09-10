import { describe, expect, it, vi } from 'vitest'

import {
  GOOGLE_GMAIL_SCOPES,
  GoogleOAuthManager,
  readGoogleOAuthConfig,
  scopesForGoogleService
} from './google-oauth-manager'
import { SecureKeychainStore } from './secure-keychain-store'

function memoryStore(): SecureKeychainStore {
  const items = new Map<string, string>()
  return new SecureKeychainStore('com.omnicode.editor.oauth', async (args, stdin) => {
    if (args[0] === '-i') {
      const match = stdin?.match(/^add-generic-password -U -s ([A-Za-z0-9._-]+) -a ([A-Za-z0-9._-]+) -X ([a-f\d]+)\n$/u)
      if (!match) throw new Error('Unexpected Keychain write.')
      items.set(`${match[1]}:${match[2]}`, Buffer.from(match[3], 'hex').toString('utf8'))
      return ''
    }
    const key = `${args[args.indexOf('-s') + 1]}:${args[args.indexOf('-a') + 1]}`
    if (args[0] === 'find-generic-password') {
      const value = items.get(key)
      if (value === undefined) throw new Error('The specified item could not be found in the keychain.')
      return value
    }
    if (args[0] === 'delete-generic-password') {
      if (!items.delete(key)) throw new Error('The specified item could not be found in the keychain.')
      return ''
    }
    throw new Error('Unexpected Keychain command.')
  })
}

const config = {
  clientId: '123456789-test.apps.googleusercontent.com',
  clientSecret: 'installed-client-secret'
}

describe('GoogleOAuthManager', () => {
  it('uses a system-browser loopback flow with state and S256 PKCE, then verifies the account', async () => {
    let authorizationUrl: URL | undefined
    let tokenBody = ''
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenBody = String(init?.body)
        return new Response(JSON.stringify({
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value',
          expires_in: 3_600,
          token_type: 'Bearer',
          scope: `openid email profile ${GOOGLE_GMAIL_SCOPES[0]}`
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-token-value')
        return new Response(JSON.stringify({ sub: 'account-1', email: 'person@example.com', name: 'Person' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }) as unknown as typeof fetch
    const manager = new GoogleOAuthManager(config, memoryStore(), {
      fetch: fetchMock,
      authorizationTimeoutMs: 2_000,
      openExternal: async (url) => {
        authorizationUrl = new URL(url)
        const callback = authorizationUrl.searchParams.get('redirect_uri') as string
        const state = authorizationUrl.searchParams.get('state') as string
        queueMicrotask(() => { void globalThis.fetch(`${callback}?code=authorization-code&state=${encodeURIComponent(state)}`) })
      }
    })

    await expect(manager.connect('gmail')).resolves.toMatchObject({ email: 'person@example.com' })

    expect(authorizationUrl?.origin).toBe('https://accounts.google.com')
    expect(authorizationUrl?.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl?.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(authorizationUrl?.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/u)
    expect(authorizationUrl?.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/u)
    expect(authorizationUrl?.searchParams.get('scope')).toContain(GOOGLE_GMAIL_SCOPES[0])
    expect(authorizationUrl?.toString()).not.toContain(config.clientSecret)
    expect(new URLSearchParams(tokenBody).get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/u)
    expect(new URLSearchParams(tokenBody).get('client_secret')).toBe(config.clientSecret)

    await expect(manager.verify('gmail')).resolves.toMatchObject({
      state: 'connected',
      message: 'Connected as person@example.com.'
    })
  })

  it('remains honestly disconnected when no OAuth client or Keychain token exists', async () => {
    const manager = new GoogleOAuthManager(undefined, memoryStore(), {
      fetch: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn()
    })

    await expect(manager.verify('google-drive')).resolves.toMatchObject({
      state: 'not-connected',
      grantedScopes: []
    })
    await expect(manager.connect('google-drive')).rejects.toThrow('not configured')
  })

  it('rejects a callback whose anti-CSRF state does not match', async () => {
    const manager = new GoogleOAuthManager(config, memoryStore(), {
      fetch: vi.fn() as unknown as typeof fetch,
      authorizationTimeoutMs: 2_000,
      openExternal: async (url) => {
        const callback = new URL(url).searchParams.get('redirect_uri') as string
        queueMicrotask(() => { void globalThis.fetch(`${callback}?code=authorization-code&state=wrong-state`) })
      }
    })

    await expect(manager.connect('gmail')).rejects.toThrow('state validation failed')
  })

  it('prevents simultaneous Google authorization windows from racing the shared grant', async () => {
    let release: (() => void) | undefined
    const opened = new Promise<void>((resolve) => { release = resolve })
    const manager = new GoogleOAuthManager(config, memoryStore(), {
      fetch: vi.fn() as unknown as typeof fetch,
      authorizationTimeoutMs: 50,
      openExternal: async () => opened
    })
    const first = manager.connect('gmail')
    await Promise.resolve()
    await expect(manager.connect('google-drive')).rejects.toThrow('already in progress')
    release?.()
    await expect(first).rejects.toThrow('timed out')
  })

  it('refreshes an expired access token and revokes the grant on disconnect', async () => {
    let now = 1_000_000
    let tokenCalls = 0
    let revokedToken = ''
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenCalls += 1
        if (tokenCalls === 1) return new Response(JSON.stringify({
          access_token: 'initial-access', refresh_token: 'refresh-value', expires_in: 61,
          token_type: 'Bearer', scope: `openid email profile ${GOOGLE_GMAIL_SCOPES[0]}`
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('refresh-value')
        return new Response(JSON.stringify({ access_token: 'refreshed-access', expires_in: 3_600, token_type: 'Bearer' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({ sub: 'account-1', email: 'person@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://oauth2.googleapis.com/revoke') {
        revokedToken = new URLSearchParams(String(init?.body)).get('token') ?? ''
        return new Response('', { status: 200 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }) as unknown as typeof fetch
    const store = memoryStore()
    const manager = new GoogleOAuthManager(config, store, {
      fetch: fetchMock,
      now: () => now,
      authorizationTimeoutMs: 2_000,
      openExternal: async (url) => {
        const parsed = new URL(url)
        const callback = parsed.searchParams.get('redirect_uri') as string
        const state = parsed.searchParams.get('state') as string
        queueMicrotask(() => { void globalThis.fetch(`${callback}?code=authorization-code&state=${encodeURIComponent(state)}`) })
      }
    })
    await manager.connect('gmail')
    now += 2_000

    await expect(manager.getAccessToken(GOOGLE_GMAIL_SCOPES)).resolves.toBe('refreshed-access')
    await manager.disconnect()

    expect(revokedToken).toBe('refresh-value')
    await expect(store.has('google-workspace')).resolves.toBe(false)
  })
})

describe('Google OAuth configuration', () => {
  it('accepts only a registered Google client ID and maps the minimum service scopes', () => {
    expect(readGoogleOAuthConfig({ OMNICODE_GOOGLE_OAUTH_CLIENT_ID: config.clientId })).toEqual({ clientId: config.clientId })
    expect(readGoogleOAuthConfig({}, config)).toEqual(config)
    expect(readGoogleOAuthConfig({ OMNICODE_GOOGLE_OAUTH_CLIENT_ID: '999-runtime.apps.googleusercontent.com' }, config)).toEqual({
      clientId: '999-runtime.apps.googleusercontent.com'
    })
    expect(() => readGoogleOAuthConfig({ OMNICODE_GOOGLE_OAUTH_CLIENT_ID: 'not-a-google-client' })).toThrow('registered Google')
    expect(scopesForGoogleService('gmail')).toEqual(GOOGLE_GMAIL_SCOPES)
    expect(scopesForGoogleService('google-drive')).toContain('https://www.googleapis.com/auth/drive')
  })
})
