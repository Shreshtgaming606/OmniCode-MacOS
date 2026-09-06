import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { buildShellCommand } from './terminal-command'

describe('buildShellCommand', () => {
  it('quotes arguments and environment values while reporting the real exit code', () => {
    const command = buildShellCommand({
      command: '/usr/bin/printf',
      args: ['value with spaces\n'],
      cwd: '/tmp',
      env: { OMNICODE_TEST_VALUE: "quote'value" }
    })

    expect(command).toContain("OMNICODE_TEST_VALUE='quote'\\''value'")
    expect(command).toContain("'/usr/bin/printf' 'value with spaces")
    expect(command).toContain('__omnicode_exit_code=$?')
    expect(command).toContain('[Process exited with code %d]')
  })

  it.each([
    ['/usr/bin/true', 0],
    ['/usr/bin/false', 1]
  ])('prints the exit code for %s', (executable, expectedExitCode) => {
    const command = buildShellCommand({ command: executable, args: [], cwd: '/tmp' })
    const result = spawnSync('/bin/zsh', ['-lc', command ?? ''], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`[Process exited with code ${expectedExitCode}]`)
  })

  it('rejects unsafe environment variable names', () => {
    expect(() => buildShellCommand({
      command: '/usr/bin/true', args: [], cwd: '/tmp', env: { 'INVALID-NAME': 'value' }
    })).toThrow(/environment variable name/iu)
  })
})
