import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const GOOGLE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024

export interface GoogleOAuthBuildConfig {
  clientId: string
  clientSecret?: string
  testing: boolean
}

type ReadCredentialFile = (path: string) => Buffer

function cleanEnvironmentValue(value: string | undefined, label: string, maximum: number): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const normalized = value.trim()
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function parseTestingFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === '0' || normalized === 'false') return false
  if (normalized === '1' || normalized === 'true') return true
  throw new Error('Google OAuth testing flag must be 1, 0, true, or false.')
}

function requireDesktopClientId(value: unknown): string {
  if (typeof value !== 'string' || !GOOGLE_CLIENT_ID_PATTERN.test(value.trim())) {
    throw new Error('Google OAuth developer configuration does not contain a valid Desktop app client ID.')
  }
  return value.trim()
}

function optionalDesktopClientSecret(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Google OAuth developer configuration contains invalid Desktop client metadata.')
  }
  return value
}

function parseDesktopCredentialFile(data: Buffer): { clientId: string; clientSecret?: string } {
  if (data.byteLength === 0 || data.byteLength > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error('Google OAuth developer credentials file has an invalid size.')
  }
  let value: unknown
  try {
    value = JSON.parse(data.toString('utf8'))
  } catch {
    throw new Error('Google OAuth developer credentials file is not valid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Google OAuth developer credentials file is invalid.')
  }
  const installed = (value as Record<string, unknown>).installed
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
    throw new Error('Google OAuth developer credentials must use the Desktop app client type.')
  }
  const record = installed as Record<string, unknown>
  if (record.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' || record.token_uri !== 'https://oauth2.googleapis.com/token') {
    throw new Error('Google OAuth developer credentials contain unsupported endpoints.')
  }
  if (!Array.isArray(record.redirect_uris) || !record.redirect_uris.some((uri) => uri === 'http://localhost' || uri === 'http://127.0.0.1')) {
    throw new Error('Google OAuth Desktop app credentials must allow a loopback redirect.')
  }
  const clientSecret = optionalDesktopClientSecret(record.client_secret)
  return {
    clientId: requireDesktopClientId(record.client_id),
    ...(clientSecret ? { clientSecret } : {})
  }
}

/**
 * Resolves OmniCode's publisher-owned Google OAuth identity while the trusted
 * main bundle is being built. The raw JSON and its filesystem path are never
 * defined into the application bundle. Desktop clients are public clients, so
 * any downloaded client_secret is compatibility metadata rather than a
 * confidentiality boundary; PKCE and state provide the native-flow protection.
 */
export function readGoogleOAuthBuildConfig(
  environment: NodeJS.ProcessEnv = process.env,
  readCredentialFile: ReadCredentialFile = (path) => readFileSync(path)
): GoogleOAuthBuildConfig | undefined {
  const credentialPath = cleanEnvironmentValue(
    environment.OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE,
    'Google OAuth developer credentials path',
    4_096
  )
  const directClientId = cleanEnvironmentValue(
    environment.OMNICODE_GOOGLE_OAUTH_CLIENT_ID,
    'Google OAuth client ID',
    512
  )
  const directClientSecret = cleanEnvironmentValue(
    environment.OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET,
    'Google OAuth Desktop client metadata',
    2_048
  )
  if (credentialPath && (directClientId || directClientSecret)) {
    throw new Error('Configure Google OAuth with either a developer credentials file or direct publisher client metadata, not both.')
  }
  if (directClientSecret && !directClientId) throw new Error('Google OAuth direct client metadata requires a client ID.')
  const testing = parseTestingFlag(environment.OMNICODE_GOOGLE_OAUTH_TESTING)
  if (credentialPath) {
    if (!isAbsolute(credentialPath)) throw new Error('Google OAuth developer credentials path must be absolute.')
    let data: Buffer
    try {
      data = readCredentialFile(credentialPath)
    } catch {
      throw new Error('Google OAuth developer credentials file could not be read.')
    }
    return { ...parseDesktopCredentialFile(data), testing }
  }
  if (!directClientId) return undefined
  return {
    clientId: requireDesktopClientId(directClientId),
    ...(directClientSecret ? { clientSecret: directClientSecret } : {}),
    testing
  }
}
