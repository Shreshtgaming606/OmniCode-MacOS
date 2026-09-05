import { describe, expect, it } from 'vitest'
import { isSensitiveRelativePath, isSensitiveWorkspacePath } from './sensitive-paths'

describe('sensitive workspace paths', () => {
  it('recognizes credentials, environment files, keys, and private metadata', () => {
    for (const target of [
      '.env', 'config/.env.production', '.git/config', '.omnicode/settings.json',
      '.aws/credentials', '.npmrc', 'certificates/signing.p12', 'id_ed25519'
    ]) {
      expect(isSensitiveRelativePath(target), target).toBe(true)
    }
  })

  it('does not block normal project source', () => {
    expect(isSensitiveRelativePath('src/environment.ts')).toBe(false)
    expect(isSensitiveRelativePath('public/index.html')).toBe(false)
    expect(isSensitiveWorkspacePath('/workspace', '/workspace/src/main.ts')).toBe(false)
  })

  it('treats paths outside the workspace as unsafe', () => {
    expect(isSensitiveWorkspacePath('/workspace', '/other/file.txt')).toBe(true)
  })
})
