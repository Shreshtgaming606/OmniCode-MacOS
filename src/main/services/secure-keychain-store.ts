import { runSecurityCommand } from './credential-manager'

const KEYCHAIN_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u
const MAX_SECRET_BYTES = 128 * 1024

export type KeychainCommand = (args: string[], stdin?: string) => Promise<string>

export class SecureItemNotFoundError extends Error {
  constructor(readonly account: string) {
    super('The secure item is not stored in macOS Keychain.')
    this.name = 'SecureItemNotFoundError'
  }
}

function validateName(value: string, label: string): string {
  if (typeof value !== 'string' || !KEYCHAIN_NAME_PATTERN.test(value)) {
    throw new Error(`${label} contains unsupported characters.`)
  }
  return value
}

function isMissingItem(error: unknown): boolean {
  return error instanceof Error && /(?:could not be found|errSecItemNotFound)/iu.test(error.message)
}

/**
 * Minimal generic-password wrapper for structured secrets such as OAuth token
 * records. Secret bytes are hex encoded on stdin so they never appear in argv.
 */
export class SecureKeychainStore {
  readonly #service: string

  constructor(service: string, private readonly runSecurity: KeychainCommand = runSecurityCommand) {
    this.#service = validateName(service, 'Keychain service')
  }

  async set(account: string, value: string): Promise<void> {
    const safeAccount = validateName(account, 'Keychain account')
    if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
      throw new Error('The secure value is empty or too large.')
    }
    const encoded = Buffer.from(value, 'utf8').toString('hex')
    await this.runSecurity(
      ['-i'],
      `add-generic-password -U -s ${this.#service} -a ${safeAccount} -X ${encoded}\n`
    )
    if (await this.get(safeAccount) !== value) {
      throw new Error('macOS Keychain did not save the secure value correctly.')
    }
  }

  async get(account: string): Promise<string> {
    const safeAccount = validateName(account, 'Keychain account')
    try {
      const value = await this.runSecurity([
        'find-generic-password', '-s', this.#service, '-a', safeAccount, '-w'
      ])
      if (!value) throw new SecureItemNotFoundError(safeAccount)
      return value
    } catch (error) {
      if (error instanceof SecureItemNotFoundError) throw error
      if (isMissingItem(error)) throw new SecureItemNotFoundError(safeAccount)
      throw error
    }
  }

  async has(account: string): Promise<boolean> {
    try {
      await this.get(account)
      return true
    } catch (error) {
      if (error instanceof SecureItemNotFoundError) return false
      throw error
    }
  }

  async delete(account: string): Promise<void> {
    const safeAccount = validateName(account, 'Keychain account')
    try {
      await this.runSecurity(['delete-generic-password', '-s', this.#service, '-a', safeAccount])
    } catch (error) {
      if (!isMissingItem(error)) throw error
    }
  }
}
