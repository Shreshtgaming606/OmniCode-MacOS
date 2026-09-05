import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSystemManager, isPathInside } from './filesystem-manager'

const { trashItem } = vi.hoisted(() => ({ trashItem: vi.fn<(target: string) => Promise<void>>() }))

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  shell: { trashItem, openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

const temporaryDirectories: string[] = []

afterEach(async () => {
  trashItem.mockReset()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('isPathInside', () => {
  it('accepts the workspace and its descendants', () => {
    expect(isPathInside('/tmp/project', '/tmp/project')).toBe(true)
    expect(isPathInside('/tmp/project', '/tmp/project/src/main.ts')).toBe(true)
  })

  it('rejects sibling paths with the same prefix', () => {
    expect(isPathInside('/tmp/project', '/tmp/project-secrets/key')).toBe(false)
    expect(isPathInside('/tmp/project', '/tmp/project/../outside')).toBe(false)
  })
})

describe('FileSystemManager workspace boundary', () => {
  it('rejects access and mutations through symlinked parents that escape the workspace', async () => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-fs-'))
    temporaryDirectories.push(container)
    const root = path.join(container, 'workspace')
    const outside = path.join(container, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    await fs.symlink(outside, path.join(root, 'escape'))

    const manager = new FileSystemManager()
    manager.setWorkspace(root)
    await expect(manager.readFile(path.join(root, 'escape', 'secret.txt'))).rejects.toThrow(/outside the current workspace/i)
    await expect(manager.writeFile(path.join(root, 'escape', 'created.txt'), 'blocked')).rejects.toThrow(/outside the current workspace/i)
    await expect(manager.renameEntry(path.join(root, 'escape', 'secret.txt'), 'renamed.txt')).rejects.toThrow(/outside the current workspace/i)
    await expect(manager.moveEntry(path.join(root, 'escape', 'secret.txt'), root)).rejects.toThrow(/outside the current workspace/i)
    await expect(manager.trashEntry(path.join(root, 'escape', 'secret.txt'))).rejects.toThrow(/outside the current workspace/i)
    expect(trashItem).not.toHaveBeenCalled()
    await expect(fs.access(path.join(outside, 'created.txt'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('requires the workspace to be granted before reading its tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-fs-'))
    temporaryDirectories.push(root)
    await expect(new FileSystemManager().readTree(root)).rejects.toThrow(/open a workspace/i)
  })

  it('detects external save conflicts and preserves executable permissions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-fs-'))
    temporaryDirectories.push(root)
    const target = path.join(root, 'script.sh')
    await fs.writeFile(target, '#!/bin/zsh\necho old\n', { mode: 0o755 })
    const manager = new FileSystemManager()
    manager.setWorkspace(root)
    const opened = await manager.readFile(target)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await fs.writeFile(target, '#!/bin/zsh\necho external\n')
    await expect(manager.writeFile(target, '#!/bin/zsh\necho editor\n', opened.modifiedAt)).rejects.toThrow(/changed on disk/i)

    const latest = await manager.readFile(target)
    await manager.writeFile(target, '#!/bin/zsh\necho saved\n', latest.modifiedAt)
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755)
  })

  it('never overwrites an existing item during rename or move', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-fs-'))
    temporaryDirectories.push(root)
    const source = path.join(root, 'source.txt')
    const existing = path.join(root, 'existing.txt')
    const destinationDirectory = path.join(root, 'destination')
    await fs.writeFile(source, 'source')
    await fs.writeFile(existing, 'keep me')
    await fs.mkdir(destinationDirectory)
    await fs.writeFile(path.join(destinationDirectory, 'source.txt'), 'also keep me')

    const manager = new FileSystemManager()
    manager.setWorkspace(root)
    await expect(manager.renameEntry(source, 'existing.txt')).rejects.toThrow(/already exists/i)
    expect(await fs.readFile(existing, 'utf8')).toBe('keep me')
    expect(await fs.readFile(source, 'utf8')).toBe('source')

    await expect(manager.moveEntry(source, destinationDirectory)).rejects.toThrow(/already exists/i)
    expect(await fs.readFile(path.join(destinationDirectory, 'source.txt'), 'utf8')).toBe('also keep me')
    expect(await fs.readFile(source, 'utf8')).toBe('source')
  })

  it('trashes a symlink entry without trashing its target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-fs-'))
    temporaryDirectories.push(root)
    const target = path.join(root, 'target.txt')
    const link = path.join(root, 'link.txt')
    await fs.writeFile(target, 'keep me')
    await fs.symlink('target.txt', link)
    trashItem.mockImplementation(async (entry) => fs.unlink(entry))

    const manager = new FileSystemManager()
    const canonicalRoot = manager.setWorkspace(root)
    await manager.trashEntry(link)

    expect(trashItem).toHaveBeenCalledWith(path.join(canonicalRoot, 'link.txt'))
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(target, 'utf8')).toBe('keep me')
  })

  it('renames and moves symlink entries without moving their targets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-fs-'))
    temporaryDirectories.push(root)
    const target = path.join(root, 'target.txt')
    const link = path.join(root, 'link.txt')
    const renamed = path.join(root, 'renamed.txt')
    const destinationDirectory = path.join(root, 'destination')
    const moved = path.join(destinationDirectory, 'renamed.txt')
    await fs.writeFile(target, 'keep me')
    await fs.mkdir(destinationDirectory)
    await fs.symlink(target, link)

    const manager = new FileSystemManager()
    const canonicalRoot = manager.setWorkspace(root)
    expect(await manager.renameEntry(link, 'renamed.txt')).toBe(path.join(canonicalRoot, 'renamed.txt'))
    expect((await fs.lstat(renamed)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(renamed)).toBe(target)
    expect(await fs.readFile(target, 'utf8')).toBe('keep me')

    expect(await manager.moveEntry(renamed, destinationDirectory)).toBe(path.join(canonicalRoot, 'destination', 'renamed.txt'))
    expect((await fs.lstat(moved)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(moved)).toBe(target)
    expect(await fs.readFile(target, 'utf8')).toBe('keep me')
  })
})
