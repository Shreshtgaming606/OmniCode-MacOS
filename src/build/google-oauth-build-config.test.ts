import { describe, expect, it, vi } from 'vitest'

import { readGoogleOAuthBuildConfig } from './google-oauth-build-config'

const desktopClientId = '123456789-omnicode.apps.googleusercontent.com'

function desktopCredentials(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    installed: {
      client_id: desktopClientId,
      client_secret: 'desktop-public-value',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      redirect_uris: ['http://localhost'],
      ...overrides
    }
  }))
}

describe('Google OAuth publisher build configuration', () => {
  it('loads developer-only Desktop public-client metadata without returning its path or JSON body', () => {
    const read = vi.fn(() => desktopCredentials())
    const result = readGoogleOAuthBuildConfig({
      OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: '/private/omnicode-google.json',
      OMNICODE_GOOGLE_OAUTH_TESTING: '1'
    }, read)

    expect(result).toEqual({ clientId: desktopClientId, clientSecret: 'desktop-public-value', testing: true })
    expect(read).toHaveBeenCalledWith('/private/omnicode-google.json')
  })

  it('supports a direct publisher client ID for CI production builds', () => {
    expect(readGoogleOAuthBuildConfig({
      OMNICODE_GOOGLE_OAUTH_CLIENT_ID: desktopClientId,
      OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET: 'desktop-public-value'
    })).toEqual({
      clientId: desktopClientId,
      clientSecret: 'desktop-public-value',
      testing: false
    })
  })

  it('rejects web clients, unsupported endpoints, relative paths, and mixed inputs', () => {
    expect(() => readGoogleOAuthBuildConfig(
      { OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: '/private/web.json' },
      () => Buffer.from(JSON.stringify({ web: { client_id: desktopClientId } }))
    )).toThrow('Desktop app')
    expect(() => readGoogleOAuthBuildConfig(
      { OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: '/private/oauth.json' },
      () => desktopCredentials({ token_uri: 'https://example.com/token' })
    )).toThrow('unsupported endpoints')
    expect(() => readGoogleOAuthBuildConfig(
      { OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: 'oauth.json' },
      () => desktopCredentials()
    )).toThrow('absolute')
    expect(() => readGoogleOAuthBuildConfig({
      OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: '/private/oauth.json',
      OMNICODE_GOOGLE_OAUTH_CLIENT_ID: desktopClientId
    }, () => desktopCredentials())).toThrow('either')
    expect(() => readGoogleOAuthBuildConfig({
      OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET: 'orphaned-public-client-value'
    })).toThrow('requires a client ID')
  })

  it('does not leak file contents or paths through read/parse errors', () => {
    const privatePath = '/private/should-not-appear.json'
    expect(() => readGoogleOAuthBuildConfig(
      { OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: privatePath },
      () => { throw new Error('filesystem detail') }
    )).toThrow('could not be read')
    try {
      readGoogleOAuthBuildConfig(
        { OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE: privatePath },
        () => Buffer.from('{private-value')
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(privatePath)
      expect(message).not.toContain('private-value')
    }
  })
})
