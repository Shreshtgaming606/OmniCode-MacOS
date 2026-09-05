import path from 'node:path'

const SENSITIVE_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.omnicode', '.ssh', '.aws', '.gnupg'
])

const SENSITIVE_FILENAMES = new Set([
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', '.netrc', '.pypirc',
  '.dockerconfigjson', 'credentials', 'credentials.json', 'secrets.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
])

const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx',
  '.mobileprovision'
])

/**
 * Returns true for paths that should never be discovered by automatic AI
 * indexing or exposed through OmniCode's convenience static server.
 */
export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//u, '')
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length) return false
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment.toLowerCase()))) return true

  const filename = segments.at(-1)?.toLowerCase() ?? ''
  if (/^\.env(?:\..*)?$/u.test(filename)) return true
  if (SENSITIVE_FILENAMES.has(filename)) return true
  if (/^(?:credentials|secrets?)(?:\.[^.]+)?$/u.test(filename)) return true
  return SENSITIVE_EXTENSIONS.has(path.extname(filename))
}

export function isSensitiveWorkspacePath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '.') return false
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true
  return isSensitiveRelativePath(relative)
}

