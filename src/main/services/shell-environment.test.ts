import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseEnvironment, withCommonMacPaths } from './shell-environment'

describe('shell environment', () => {
  it('ignores shell startup output before the marker and parses NUL records', () => {
    const value = parseEnvironment(
      `startup message\n\0__OMNICODE_ENVIRONMENT__\0PATH=/custom/bin\0SDKROOT=/sdk path\0BAD-NAME=nope\0`,
      { PATH: '/usr/bin', HOME: '/Users/test' }
    )
    expect(value.SDKROOT).toBe('/sdk path')
    expect(value['BAD-NAME']).toBeUndefined()
    expect(value.PATH?.split(path.delimiter)).toEqual(expect.arrayContaining(['/custom/bin', '/usr/bin', '/opt/homebrew/bin']))
  })

  it('preserves base variables and adds both Homebrew locations once', () => {
    const value = withCommonMacPaths({ PATH: '/usr/local/bin' }, { PATH: '/usr/bin', TEST_VALUE: 'kept', HOME: '/Users/test' })
    expect(value.TEST_VALUE).toBe('kept')
    const entries = value.PATH?.split(path.delimiter) ?? []
    expect(entries.filter((entry) => entry === '/usr/local/bin')).toHaveLength(1)
    expect(entries).toContain('/opt/homebrew/bin')
  })
})
