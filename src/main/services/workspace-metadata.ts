import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { isPathInside } from './filesystem-manager'

async function lstatIfPresent(target: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertSimpleName(name: string, label: string): void {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name || name.includes('\0')) {
    throw new Error(`${label} must be a single path name.`)
  }
}

export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  const canonical = await fs.realpath(path.resolve(root))
  const stats = await fs.stat(canonical)
  if (!stats.isDirectory()) throw new Error('The workspace root must be a directory.')
  return canonical
}

export async function workspaceMetadataDirectory(root: string, create: boolean): Promise<string> {
  const canonicalRoot = await canonicalWorkspaceRoot(root)
  const directory = path.join(canonicalRoot, '.omnicode')
  let stats = await lstatIfPresent(directory)
  if (!stats && create) {
    try {
      await fs.mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    stats = await fs.lstat(directory)
  }
  if (!stats) return directory
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('.omnicode must be a real directory inside the workspace, not a file or symbolic link.')
  }
  const canonicalDirectory = await fs.realpath(directory)
  if (!isPathInside(canonicalRoot, canonicalDirectory)) {
    throw new Error('OmniCode blocked workspace metadata outside the current workspace.')
  }
  return canonicalDirectory
}

export async function workspaceMetadataFile(root: string, name: string, createDirectory = false): Promise<string> {
  assertSimpleName(name, 'Workspace metadata file')
  const directory = await workspaceMetadataDirectory(root, createDirectory)
  const target = path.join(directory, name)
  const stats = await lstatIfPresent(target)
  if (stats?.isSymbolicLink()) throw new Error(`.omnicode/${name} must not be a symbolic link.`)
  if (stats && !stats.isFile()) throw new Error(`.omnicode/${name} must be a regular file.`)
  return target
}

export async function workspaceMetadataSubdirectory(root: string, name: string, create: boolean): Promise<string> {
  assertSimpleName(name, 'Workspace metadata directory')
  const metadata = await workspaceMetadataDirectory(root, create)
  const directory = path.join(metadata, name)
  let stats = await lstatIfPresent(directory)
  if (!stats && create) {
    try {
      await fs.mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    stats = await fs.lstat(directory)
  }
  if (!stats) return directory
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`.omnicode/${name} must be a real directory, not a file or symbolic link.`)
  }
  const canonicalDirectory = await fs.realpath(directory)
  if (!isPathInside(metadata, canonicalDirectory)) {
    throw new Error('OmniCode blocked workspace metadata outside the current workspace.')
  }
  return canonicalDirectory
}

export async function workspaceRootFile(root: string, name: string): Promise<string | null> {
  assertSimpleName(name, 'Workspace file')
  const canonicalRoot = await canonicalWorkspaceRoot(root)
  const target = path.join(canonicalRoot, name)
  const stats = await lstatIfPresent(target)
  if (!stats) return null
  if (stats.isSymbolicLink()) throw new Error(`${name} must not be a symbolic link.`)
  if (!stats.isFile()) throw new Error(`${name} must be a regular file.`)
  return target
}

export async function workspaceWorkingDirectory(root: string, configuredPath = '.'): Promise<string> {
  const canonicalRoot = await canonicalWorkspaceRoot(root)
  const requested = path.resolve(canonicalRoot, configuredPath)
  if (!isPathInside(canonicalRoot, requested)) {
    throw new Error('The workspace run working directory must stay inside the workspace.')
  }
  let canonical: string
  try {
    canonical = await fs.realpath(requested)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('The workspace run working directory does not exist.')
    }
    throw error
  }
  if (!isPathInside(canonicalRoot, canonical)) {
    throw new Error('The workspace run working directory must stay inside the workspace and cannot resolve through an external symbolic link.')
  }
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error('The workspace run working directory must be a directory.')
  return canonical
}

export async function safeMetadataOutput(root: string, name: string): Promise<string> {
  assertSimpleName(name, 'Build output')
  const directory = await workspaceMetadataSubdirectory(root, 'run', true)
  const target = path.join(directory, name)
  const stats = await lstatIfPresent(target)
  if (stats?.isSymbolicLink()) throw new Error(`The build output .omnicode/run/${name} must not be a symbolic link.`)
  if (stats?.isDirectory()) throw new Error(`The build output .omnicode/run/${name} is a directory.`)
  return target
}

export async function readBoundedTextFile(target: string, maxBytes: number, label: string): Promise<string> {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(`${label} must be a regular file.`)
    if (stats.size > maxBytes) throw new Error(`${label} is too large.`)
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes) throw new Error(`${label} is too large.`)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
