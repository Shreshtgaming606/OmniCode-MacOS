import { spawn } from 'node:child_process'
import type { AIProviderId } from '../../shared/contracts'

type CloudProvider = Exclude<AIProviderId, 'ollama'>
const SERVICE = 'com.omnicode.editor.ai'

type SecurityCommand = (args: string[], stdin?: string) => Promise<string>

export class CredentialNotFoundError extends Error {
  constructor(readonly provider: CloudProvider) {
    super(`No ${provider} API key is stored.`)
    this.name = 'CredentialNotFoundError'
  }
}

export function parseSecurityResult(
  code: number | null,
  stdout: string,
  stderr: string,
  command?: string
): string {
  const detail = stderr.trim()
  // `security` writes this success notice to stderr after a deletion. Other
  // diagnostics, especially interactive write errors with exit code zero,
  // remain failures.
  const deleted = command === 'delete-generic-password' && detail === 'password has been deleted.'
  if (code !== 0 || (detail && !deleted)) {
    throw new Error(detail || 'macOS Keychain operation failed.')
  }
  return stdout.trim()
}

export function runSecurityCommand(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.stdin.on('error', reject)
    if (stdin) child.stdin.end(stdin)
    else child.stdin.end()
    child.on('close', (code) => {
      try {
        resolve(parseSecurityResult(code, stdout, stderr, args[0]))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export class CredentialManager {
  constructor(private readonly runSecurity: SecurityCommand = runSecurityCommand) {}

  async set(provider: CloudProvider, apiKey: string): Promise<void> {
    if (typeof apiKey !== 'string') throw new Error('Enter a valid API key.')
    const normalized = apiKey.trim()
    if (!normalized) throw new Error('Enter a non-empty API key.')
    // Provider-issued API keys are printable ASCII. Restricting the accepted
    // value also guarantees `security find-generic-password -w` returns the
    // original text instead of its hexadecimal display form.
    if (apiKey.length > 16_384 || !/^[ -~]+$/u.test(normalized)) {
      throw new Error('The API key contains unsupported characters or is too long.')
    }

    // `security add-generic-password ... -w` prompts for the password twice when
    // no argument is supplied. Feeding it one line can exit successfully after
    // storing an empty value. Interactive mode plus -X is deterministic, and
    // keeps the credential on stdin instead of exposing it in argv.
    const encoded = Buffer.from(normalized, 'utf8').toString('hex')
    await this.runSecurity(
      ['-i'],
      `add-generic-password -U -s ${SERVICE} -a ${provider} -X ${encoded}\n`
    )

    // Never tell the renderer that a credential was saved until Keychain can
    // return the exact value that was written.
    let stored: string
    try {
      stored = await this.get(provider)
    } catch (error) {
      if (error instanceof CredentialNotFoundError) {
        throw new Error(`macOS Keychain did not save the ${provider} API key correctly.`)
      }
      throw error
    }
    if (stored !== normalized) {
      throw new Error(`macOS Keychain did not save the ${provider} API key correctly.`)
    }
  }

  async get(provider: CloudProvider): Promise<string> {
    try {
      const value = await this.runSecurity(['find-generic-password', '-s', SERVICE, '-a', provider, '-w'])
      if (!value) throw new CredentialNotFoundError(provider)
      return value
    } catch (error) {
      if (error instanceof CredentialNotFoundError) throw error
      if (error instanceof Error && /(?:could not be found|errSecItemNotFound)/iu.test(error.message)) {
        throw new CredentialNotFoundError(provider)
      }
      throw error
    }
  }

  async has(provider: CloudProvider): Promise<boolean> {
    try {
      await this.get(provider)
      return true
    } catch (error) {
      if (error instanceof CredentialNotFoundError) return false
      throw error
    }
  }

  async delete(provider: CloudProvider): Promise<void> {
    try {
      await this.runSecurity(['delete-generic-password', '-s', SERVICE, '-a', provider])
    } catch (error) {
      if (!(error instanceof Error) || !/(?:could not be found|errSecItemNotFound)/iu.test(error.message)) throw error
    }
  }
}
