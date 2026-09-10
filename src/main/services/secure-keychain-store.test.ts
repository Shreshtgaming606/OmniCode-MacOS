import { describe, expect, it } from 'vitest'

import { SecureItemNotFoundError, SecureKeychainStore } from './secure-keychain-store'

type KeychainCall = { args: string[]; stdin?: string }

function memoryKeychain(calls: KeychainCall[]) {
  const items = new Map<string, string>()
  return async (args: string[], stdin?: string): Promise<string> => {
    calls.push({ args: [...args], stdin })
    if (args[0] === '-i') {
      const match = stdin?.match(/^add-generic-password -U -s ([A-Za-z0-9._-]+) -a ([A-Za-z0-9._-]+) -X ([a-f\d]+)\n$/u)
      if (!match) throw new Error('Unexpected Keychain write.')
      items.set(`${match[1]}:${match[2]}`, Buffer.from(match[3], 'hex').toString('utf8'))
      return ''
    }
    const service = args[args.indexOf('-s') + 1]
    const account = args[args.indexOf('-a') + 1]
    const key = `${service}:${account}`
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
  }
}

describe('SecureKeychainStore', () => {
  it('round-trips structured Unicode data without placing it in command arguments', async () => {
    const calls: KeychainCall[] = []
    const store = new SecureKeychainStore('com.omnicode.editor.oauth', memoryKeychain(calls))
    const value = JSON.stringify({ refreshToken: 'secret-token', account: 'Person ☃' })

    await store.set('google-workspace', value)

    expect(await store.get('google-workspace')).toBe(value)
    expect(calls[0]?.args).toEqual(['-i'])
    expect(calls[0]?.args.join(' ')).not.toContain('secret-token')
    expect(calls[0]?.stdin).not.toContain('secret-token')
  })

  it('distinguishes a missing item from a Keychain operational failure', async () => {
    const missing = new SecureKeychainStore('com.omnicode.editor.oauth', async () => {
      throw new Error('The specified item could not be found in the keychain.')
    })
    const locked = new SecureKeychainStore('com.omnicode.editor.oauth', async () => {
      throw new Error('User interaction is not allowed.')
    })

    await expect(missing.get('google-workspace')).rejects.toBeInstanceOf(SecureItemNotFoundError)
    await expect(missing.has('google-workspace')).resolves.toBe(false)
    await expect(locked.has('google-workspace')).rejects.toThrow('User interaction is not allowed')
  })

  it('deletes idempotently and rejects unsafe Keychain identifiers', async () => {
    const calls: KeychainCall[] = []
    const store = new SecureKeychainStore('com.omnicode.editor.oauth', memoryKeychain(calls))
    await store.set('google-workspace', '{}')
    await store.delete('google-workspace')
    await store.delete('google-workspace')

    await expect(store.has('google-workspace')).resolves.toBe(false)
    await expect(store.get('unsafe account')).rejects.toThrow('unsupported characters')
    expect(() => new SecureKeychainStore('unsafe service')).toThrow('unsupported characters')
  })
})
