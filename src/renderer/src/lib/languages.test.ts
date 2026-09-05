import { describe, expect, it } from 'vitest'

import {
  LANGUAGE_DEFINITIONS,
  displayNameForPath,
  fileExtension,
  fileName,
  getLanguageDefinition,
  isRunnablePath,
  languageDefinitionForPath,
  languageForPath,
  languageIdForPath
} from './languages'

describe('language registry', () => {
  it('contains every language required by the product specification', () => {
    const required = [
      'html',
      'css',
      'javascript',
      'typescript',
      'python',
      'java',
      'c',
      'cpp',
      'objective-c',
      'objective-cpp',
      'swift',
      'csharp',
      'rust',
      'go',
      'php',
      'ruby',
      'kotlin',
      'lua',
      'json',
      'xml',
      'yaml',
      'markdown',
      'sql',
      'shell',
      'bash',
      'zsh',
      'fish',
      'dockerfile',
      'toml',
      'ini',
      'makefile',
      'gradle',
      'jsx',
      'tsx',
      'vue',
      'svelte',
      'powershell',
      'batch'
    ]
    const definitionsById = new Map(
      LANGUAGE_DEFINITIONS.map((definition) => [definition.id, definition])
    )

    for (const id of required) {
      const definition = definitionsById.get(id as (typeof LANGUAGE_DEFINITIONS)[number]['id'])
      expect(definition, `missing ${id}`).toBeDefined()
      expect(definition?.displayName).toBeTruthy()
      expect(definition?.monacoLanguageId).toBeTruthy()
    }
  })

  it.each([
    ['index.html', 'html', 'html'],
    ['theme.css', 'css', 'css'],
    ['entry.mjs', 'javascript', 'javascript'],
    ['types.d.ts', 'typescript', 'typescript'],
    ['main.py', 'python', 'python'],
    ['Main.java', 'java', 'java'],
    ['main.c', 'c', 'cpp'],
    ['engine.cpp', 'cpp', 'cpp'],
    ['delegate.m', 'objective-c', 'objective-c'],
    ['delegate.mm', 'objective-cpp', 'objective-c'],
    ['App.swift', 'swift', 'swift'],
    ['Program.cs', 'csharp', 'csharp'],
    ['lib.rs', 'rust', 'rust'],
    ['main.go', 'go', 'go'],
    ['index.php', 'php', 'php'],
    ['task.rb', 'ruby', 'ruby'],
    ['Main.kt', 'kotlin', 'kotlin'],
    ['init.lua', 'lua', 'lua'],
    ['data.json', 'json', 'json'],
    ['layout.xml', 'xml', 'xml'],
    ['config.yml', 'yaml', 'yaml'],
    ['README.md', 'markdown', 'markdown'],
    ['query.sql', 'sql', 'sql'],
    ['tool.sh', 'shell', 'shell'],
    ['tool.bash', 'bash', 'shell'],
    ['tool.zsh', 'zsh', 'shell'],
    ['config.fish', 'fish', 'shell'],
    ['Cargo.toml', 'toml', 'ini'],
    ['settings.ini', 'ini', 'ini'],
    ['rules.mk', 'makefile', 'shell'],
    ['build.gradle', 'gradle', 'java'],
    ['view.jsx', 'jsx', 'javascript'],
    ['view.tsx', 'tsx', 'typescript'],
    ['App.vue', 'vue', 'html'],
    ['App.svelte', 'svelte', 'html'],
    ['setup.ps1', 'powershell', 'powershell'],
    ['setup.cmd', 'batch', 'bat']
  ])('detects %s as %s using Monaco %s', (path, expectedId, expectedMonacoId) => {
    expect(languageIdForPath(path)).toBe(expectedId)
    expect(languageForPath(path)).toBe(expectedMonacoId)
  })

  it.each([
    ['/workspace/Dockerfile', 'dockerfile'],
    ['/workspace/dockerfile.dev', 'dockerfile'],
    ['/workspace/backend.Dockerfile', 'dockerfile'],
    ['/workspace/Containerfile', 'dockerfile'],
    ['/workspace/Makefile', 'makefile'],
    ['/workspace/GNUmakefile', 'makefile'],
    ['/workspace/Makefile.release', 'makefile'],
    ['/Users/dev/.bashrc', 'bash'],
    ['/Users/dev/.zshrc', 'zsh'],
    ['/workspace/.profile', 'shell'],
    ['/workspace/.env.local', 'shell'],
    ['/workspace/.editorconfig', 'ini'],
    ['/workspace/.prettierrc', 'json'],
    ['/workspace/Gemfile', 'ruby'],
    ['/workspace/README', 'markdown']
  ])('handles special filename %s', (path, expectedId) => {
    expect(languageIdForPath(path)).toBe(expectedId)
  })

  it('honors case-sensitive Unix compiler extensions before normalizing suffixes', () => {
    expect(languageIdForPath('Legacy.M')).toBe('objective-cpp')
    expect(languageIdForPath('Legacy.m')).toBe('objective-c')
    expect(languageIdForPath('Legacy.C')).toBe('cpp')
    expect(languageIdForPath('Legacy.c')).toBe('c')
  })

  it('handles POSIX and Windows path separators and extensionless dotfiles', () => {
    expect(fileName('/Users/dev/project/main.ts')).toBe('main.ts')
    expect(fileName('C:\\project\\script.ps1')).toBe('script.ps1')
    expect(fileExtension('.zshrc')).toBe('')
    expect(fileExtension('/tmp/archive.TS')).toBe('.ts')
  })

  it('returns rich metadata and a stable plaintext fallback', () => {
    expect(languageDefinitionForPath('unknown.no-such-language')).toEqual(
      getLanguageDefinition('plaintext')
    )
    expect(displayNameForPath('main.swift')).toBe('Swift')
    expect(languageDefinitionForPath('Cargo.toml')).toMatchObject({
      id: 'toml',
      monacoLanguageId: 'ini',
      monacoSyntaxSupport: 'fallback'
    })
  })

  it('classifies directly runnable, project-runnable, and unsupported files', () => {
    expect(isRunnablePath('main.py')).toBe(true)
    expect(isRunnablePath('Dockerfile')).toBe(true)
    expect(isRunnablePath('App.vue')).toBe(true)
    expect(isRunnablePath('styles.css')).toBe(false)
    expect(isRunnablePath('build.ps1')).toBe(false)
    expect(languageDefinitionForPath('build.ps1').executionKind).toBe('platform-specific')
  })

  it('has unique IDs and normalized, unambiguous registered extensions', () => {
    const ids = LANGUAGE_DEFINITIONS.map(({ id }) => id)
    const extensions = LANGUAGE_DEFINITIONS.flatMap(({ extensions }) => extensions)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(extensions).size).toBe(extensions.length)
    expect(extensions.every((extension) => /^\.[a-z0-9+]+$/.test(extension))).toBe(true)
  })
})
