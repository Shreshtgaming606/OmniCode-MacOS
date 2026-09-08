import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { categorizeDiagnostic, DiagnosticLogger, redactDiagnosticMessage } from './diagnostic-logger'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function temporaryLogger(options: ConstructorParameters<typeof DiagnosticLogger>[1] = {}): Promise<DiagnosticLogger> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-logs-'))
  temporaryDirectories.push(directory)
  return new DiagnosticLogger(directory, options)
}

describe('DiagnosticLogger', () => {
  it('writes bounded structured operation failures without recording call arguments or stack traces', async () => {
    const logger = await temporaryLogger({ now: () => new Date('2026-09-07T12:34:56.000Z') })
    const error = new Error('The file changed on disk.')
    error.stack = 'STACK MUST NOT BE WRITTEN'
    await logger.failure('workspace:write-file', error)

    const record = JSON.parse(await fs.readFile(logger.logPath, 'utf8'))
    expect(record).toEqual({
      timestamp: '2026-09-07T12:34:56.000Z',
      level: 'error',
      subsystem: 'workspace',
      operation: 'workspace:write-file',
      category: 'conflict',
      message: 'Error: The file changed on disk.'
    })
    expect(await fs.readFile(logger.logPath, 'utf8')).not.toContain('STACK MUST NOT BE WRITTEN')
    expect((await fs.stat(logger.logPath)).mode & 0o777).toBe(0o600)
  })

  it('redacts provider keys, authorization values, URL credentials, and query tokens', () => {
    const exposed = [
      'sk-example123456789',
      'sk-ant-example123456789',
      'AIzaExampleExampleExample12345',
      'ghp_1234567890abcdefghijkl',
      'Authorization: Bearer top-secret-value',
      'api_key=another-secret',
      'https://person:password@example.com/path?token=query-secret'
    ].join(' | ')
    const redacted = redactDiagnosticMessage(exposed)
    for (const secret of ['example123456789', 'top-secret-value', 'another-secret', 'password', 'query-secret']) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted.match(/\[REDACTED/gu)?.length).toBeGreaterThanOrEqual(7)
  })

  it('classifies common operational failures without relying on subsystem-specific error types', () => {
    expect(categorizeDiagnostic(new Error('HTTP 429 rate limit reached'))).toBe('rate-limit')
    expect(categorizeDiagnostic(new Error('fetch failed: ECONNREFUSED'))).toBe('network')
    expect(categorizeDiagnostic(new Error('request timed out'))).toBe('timeout')
    expect(categorizeDiagnostic(new Error('EACCES: permission denied'))).toBe('permission')
    expect(categorizeDiagnostic(new Error('Blocked access outside the current workspace'))).toBe('permission')
    expect(categorizeDiagnostic(new Error('No API key is stored'))).toBe('authentication')
    expect(categorizeDiagnostic(new Error('ENOENT: not found'))).toBe('not-found')
    expect(categorizeDiagnostic(new Error('HTTP 503: model is experiencing high demand'))).toBe('external')
  })

  it('serializes concurrent writes and rotates the log at its configured bound', async () => {
    const logger = await temporaryLogger({ maxBytes: 4_096 })
    await Promise.all(Array.from({ length: 36 }, (_value, index) => logger.failure('test:operation', new Error(`${index}-${'x'.repeat(120)}`))))
    await logger.flush()

    const current = await fs.readFile(logger.logPath, 'utf8')
    const backup = await fs.readFile(logger.backupPath, 'utf8')
    for (const data of [current, backup]) {
      for (const line of data.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow()
    }
    expect((await fs.stat(logger.logPath)).size).toBeLessThanOrEqual(4_096)
    expect((await fs.stat(logger.backupPath)).mode & 0o777).toBe(0o600)
  })

  it('refuses to follow a symbolic link at the active log path', async () => {
    const logger = await temporaryLogger()
    const outside = path.join(path.dirname(path.dirname(logger.logPath)), `omnicode-outside-${Date.now()}.txt`)
    temporaryDirectories.push(outside)
    await fs.writeFile(outside, 'unchanged')
    await fs.mkdir(path.dirname(logger.logPath), { recursive: true })
    await fs.symlink(outside, logger.logPath)

    await expect(logger.failure('app:test', new Error('failure'))).rejects.toThrow(/not a regular file/i)
    expect(await fs.readFile(outside, 'utf8')).toBe('unchanged')
  })
})
