import { randomBytes } from 'node:crypto'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { CredentialManager, runSecurityCommand } from './credential-manager'

// Opt in on macOS: OMNICODE_TEST_KEYCHAIN=1 npm test -- credential-manager.native
// All items live in a disposable keychain. Existing OmniCode credentials are
// never read or updated, and each manager instance uses explicit keychain paths.
it.skipIf(process.platform !== 'darwin' || process.env.OMNICODE_TEST_KEYCHAIN !== '1')(
  'round-trips and replaces every provider credential in native macOS Keychain across manager instances',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omnicode-keychain-test-'))
    const keychainPath = join(directory, 'test.keychain-db')
    const password = randomBytes(24).toString('hex')
    let created = false
    try {
      await runSecurityCommand(['create-keychain', '-p', password, keychainPath])
      created = true
      const isolatedSecurity = (args: string[], stdin?: string): Promise<string> => {
        const service = 'com.omnicode.editor.isolated-test'
        if (args[0] === '-i') {
          return runSecurityCommand(args, `${stdin!.trimEnd().replace('com.omnicode.editor.ai', service)} "${keychainPath}"\n`)
        }
        return runSecurityCommand([...args.map((value) => value === 'com.omnicode.editor.ai' ? service : value), keychainPath], stdin)
      }
      const firstLaunch = new CredentialManager(isolatedSecurity)
      const secondLaunch = new CredentialManager(isolatedSecurity)
      for (const provider of ['openai', 'anthropic', 'google'] as const) {
        const key = `fake-${provider}-${randomBytes(16).toString('hex')}`
        await expect(firstLaunch.has(provider)).resolves.toBe(false)
        await firstLaunch.set(provider, ` ${key} `)
        await expect(secondLaunch.get(provider)).resolves.toBe(key)
        await firstLaunch.set(provider, `${key}-replaced`)
        await expect(secondLaunch.get(provider)).resolves.toBe(`${key}-replaced`)
        await secondLaunch.delete(provider)
        await expect(firstLaunch.has(provider)).resolves.toBe(false)
      }
    } finally {
      if (created) await runSecurityCommand(['delete-keychain', keychainPath])
      await rmdir(directory)
    }
  },
  30_000
)
