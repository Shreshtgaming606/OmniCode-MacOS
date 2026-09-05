import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { quoteTerminalArgument, RunManager } from './run-manager'

const temporaryDirectories: string[] = []

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-run-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('quoteTerminalArgument', () => {
  it('quotes spaces and embedded apostrophes', () => {
    expect(quoteTerminalArgument('/tmp/my file')).toBe("'/tmp/my file'")
    expect(quoteTerminalArgument("it's.ts")).toBe("'it'\\''s.ts'")
  })
})

describe('RunManager', () => {
  it('uses a non-installing local TypeScript runner', async () => {
    const root = await workspace()
    const file = path.join(root, 'main.ts')
    await fs.writeFile(file, 'console.log(1)')
    const result = await new RunManager().resolve(file, root)
    expect(result.command).toBe('npx')
    expect(result.args).toEqual(['--no-install', 'tsx', file])
    expect(result.requiredTool).toBe('npm')
  })

  it('prefers project manifests and reports their required tool', async () => {
    const root = await workspace()
    const file = path.join(root, 'src', 'main.rs')
    await fs.mkdir(path.dirname(file))
    await fs.writeFile(file, 'fn main() {}')
    await fs.writeFile(path.join(root, 'Cargo.toml'), '[package]\nname="demo"\nversion="0.1.0"')
    const result = await new RunManager().resolve(file, root)
    expect(result).toMatchObject({ command: 'cargo', args: ['run'], requiredTool: 'cargo' })
  })

  it('selects the package manager associated with the lockfile', async () => {
    const root = await workspace()
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } }))
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    expect(await new RunManager().packageScripts(root)).toEqual([
      { name: 'dev', command: "pnpm run 'dev'" },
      { name: 'test', command: "pnpm run 'test'" }
    ])
  })

  it('quotes package script names before passing them through a terminal shell', async () => {
    const root = await workspace()
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { "check; echo unsafe": 'vitest' } }))
    expect(await new RunManager().packageScripts(root)).toEqual([
      { name: 'check; echo unsafe', command: "npm run 'check; echo unsafe'" }
    ])
  })

  it('rejects a custom working directory outside the workspace', async () => {
    const root = await workspace()
    const file = path.join(root, 'main.js')
    await fs.writeFile(file, '')
    await fs.mkdir(path.join(root, '.omnicode'))
    await fs.writeFile(path.join(root, '.omnicode', 'settings.json'), JSON.stringify({ run: { command: 'node', workingDirectory: '..' } }))
    await expect(new RunManager().resolve(file, root)).rejects.toThrow(/inside the workspace/i)
  })

  it('uses an explicitly configured workspace toolchain', async () => {
    const root = await workspace()
    const file = path.join(root, 'main.py')
    await fs.writeFile(file, 'print(1)')
    await fs.mkdir(path.join(root, '.omnicode'))
    await fs.writeFile(path.join(root, '.omnicode', 'settings.json'), JSON.stringify({ toolchains: { python3: '/custom/python3' } }))
    const result = await new RunManager().resolve(file, root)
    expect(result).toMatchObject({ command: '/custom/python3', requiredTool: undefined })
  })

  it('rejects run metadata symlinks that escape the workspace', async () => {
    const container = await workspace()
    const root = path.join(container, 'project')
    const outside = path.join(container, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)
    const file = path.join(root, 'main.c')
    await fs.writeFile(file, 'int main(void) { return 0; }')
    await fs.symlink(outside, path.join(root, '.omnicode'))

    await expect(new RunManager().resolve(file, root)).rejects.toThrow(/symbolic link/i)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('rejects a symlinked compiler-output directory', async () => {
    const container = await workspace()
    const root = path.join(container, 'project')
    const outside = path.join(container, 'outside')
    await fs.mkdir(path.join(root, '.omnicode'), { recursive: true })
    await fs.mkdir(outside)
    const file = path.join(root, 'main.rs')
    await fs.writeFile(file, 'fn main() {}')
    await fs.symlink(outside, path.join(root, '.omnicode', 'run'))

    await expect(new RunManager().resolve(file, root)).rejects.toThrow(/symbolic link/i)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('rejects run configuration files that are symbolic links', async () => {
    const container = await workspace()
    const root = path.join(container, 'project')
    const outside = path.join(container, 'outside.json')
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, 'main.js'), '')
    await fs.writeFile(outside, JSON.stringify({ runCommand: 'echo outside' }))
    await fs.symlink(outside, path.join(root, 'omnicode.json'))

    await expect(new RunManager().resolve(path.join(root, 'main.js'), root)).rejects.toThrow(/symbolic link/i)
  })

  it('rejects a configured working-directory symlink that leaves the workspace', async () => {
    const container = await workspace()
    const root = path.join(container, 'project')
    const outside = path.join(container, 'outside')
    await fs.mkdir(path.join(root, '.omnicode'), { recursive: true })
    await fs.mkdir(outside)
    await fs.writeFile(path.join(root, 'main.js'), '')
    await fs.symlink(outside, path.join(root, 'linked-cwd'))
    await fs.writeFile(path.join(root, '.omnicode', 'settings.json'), JSON.stringify({ run: { command: 'node', workingDirectory: 'linked-cwd' } }))

    await expect(new RunManager().resolve(path.join(root, 'main.js'), root)).rejects.toThrow(/external symbolic link/i)
  })
})
