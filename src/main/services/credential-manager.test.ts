import { describe, expect, it } from 'vitest'

import {
  CredentialManager,
  CredentialNotFoundError,
  parseSecurityResult
} from './credential-manager'

type SecurityCall = { args: string[]; stdin?: string }

function inMemoryKeychain(calls: SecurityCall[]) {
  const values = new Map<string, string>()
  return async (args: string[], stdin?: string): Promise<string> => {
    calls.push({ args: [...args], stdin })
    if (args[0] === '-i') {
      const match = stdin?.match(/^-?add-generic-password -U -s com\.omnicode\.editor\.ai -a (openai|anthropic|google) -X ([a-f\d]+)\n$/u)
      if (!match) throw new Error('Unexpected interactive Keychain command.')
      values.set(match[1], Buffer.from(match[2], 'hex').toString('utf8'))
      return ''
    }
    const provider = args[args.indexOf('-a') + 1]
    if (args[0] === 'find-generic-password') {
      const value = values.get(provider)
      if (value === undefined) throw new Error('The specified item could not be found in the keychain.')
      return value
    }
    if (args[0] === 'delete-generic-password') {
      if (!values.delete(provider)) throw new Error('The specified item could not be found in the keychain.')
      return ''
    }
    throw new Error('Unexpected Keychain command.')
  }
}

describe('CredentialManager', () => {
  it.each(['openai', 'anthropic', 'google'] as const)(
    'writes and verifies the %s credential without placing the secret in argv',
    async (provider) => {
      const calls: SecurityCall[] = []
      const manager = new CredentialManager(inMemoryKeychain(calls))
      const key = `  test-${provider}-key  `

      await manager.set(provider, key)

      expect(await manager.get(provider)).toBe(key.trim())
      expect(await manager.has(provider)).toBe(true)
      expect(calls[0]?.args).toEqual(['-i'])
      expect(calls[0]?.args.join(' ')).not.toContain(key.trim())
      expect(calls[0]?.stdin).toBe(
        `add-generic-password -U -s com.omnicode.editor.ai -a ${provider} -X ${Buffer.from(key.trim(), 'utf8').toString('hex')}\n`
      )
      expect(calls[1]?.args).toEqual([
        'find-generic-password', '-s', 'com.omnicode.editor.ai', '-a', provider, '-w'
      ])
    }
  )

  it('rejects a false-success write when Keychain returns an empty credential', async () => {
    const manager = new CredentialManager(async (args) => args[0] === '-i' ? '' : '')

    await expect(manager.set('google', 'test-google-key')).rejects.toThrow(
      'macOS Keychain did not save the google API key correctly.'
    )
  })

  it('rejects values that the Keychain CLI cannot round-trip as API-key text', async () => {
    const manager = new CredentialManager(async () => '')

    await expect(manager.set('google', 'key-☃')).rejects.toThrow('unsupported characters')
    await expect(manager.set('google', 'key\nvalue')).rejects.toThrow('unsupported characters')
    await expect(manager.set('google', undefined as unknown as string)).rejects.toThrow('valid API key')
  })

  it('reports an absent item separately from an operational Keychain failure', async () => {
    const missing = new CredentialManager(async () => {
      throw new Error('SecKeychainSearchCopyNext: The specified item could not be found in the keychain.')
    })
    const locked = new CredentialManager(async () => {
      throw new Error('User interaction is not allowed.')
    })

    await expect(missing.get('openai')).rejects.toBeInstanceOf(CredentialNotFoundError)
    await expect(missing.has('openai')).resolves.toBe(false)
    await expect(locked.has('openai')).rejects.toThrow('User interaction is not allowed.')
  })

  it('deletes credentials and treats an already absent item as deleted', async () => {
    const calls: SecurityCall[] = []
    const manager = new CredentialManager(inMemoryKeychain(calls))

    await manager.set('anthropic', 'test-anthropic-key')
    await manager.delete('anthropic')
    await manager.delete('anthropic')

    await expect(manager.has('anthropic')).resolves.toBe(false)
  })
})

describe('parseSecurityResult', () => {
  it('rejects stderr even when the security process exits zero', () => {
    expect(() => parseSecurityResult(0, '', 'passwords do not match')).toThrow(
      'passwords do not match'
    )
  })

  it('returns trimmed stdout only for a clean successful command', () => {
    expect(parseSecurityResult(0, 'credential-value\n', '')).toBe('credential-value')
    expect(() => parseSecurityResult(44, '', '')).toThrow('macOS Keychain operation failed.')
  })

  it('accepts the native successful-delete notice only for deletion with a zero exit code', () => {
    expect(parseSecurityResult(0, '', 'password has been deleted.\n', 'delete-generic-password')).toBe('')
    expect(() => parseSecurityResult(1, '', 'password has been deleted.', 'delete-generic-password')).toThrow()
    expect(() => parseSecurityResult(0, '', 'password has been deleted.', '-i')).toThrow()
  })
})
