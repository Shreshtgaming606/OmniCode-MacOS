import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { CloudAIProviderId } from '../../shared/model-contracts'
import {
  isCompatibleGoogleTextModelId,
  isCompatibleOpenAIModelId,
  ModelCatalogManager
} from './model-catalog-manager'

const temporaryDirectories: string[] = []

async function temporaryCache(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-model-catalog-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'nested', 'cloud-models.json')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ))
})

function configuredManager(
  fetchImplementation: typeof fetch,
  options: Partial<ConstructorParameters<typeof ModelCatalogManager>[0]> = {}
): ModelCatalogManager {
  return new ModelCatalogManager({
    getCredential: async () => 'catalog-credential',
    fetch: fetchImplementation,
    ...options
  })
}

describe('OpenAI cloud model discovery', () => {
  it('keeps conservative text-generation families and rejects specialized model families', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const manager = configuredManager((async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ data: [
        { id: 'gpt-5', owned_by: 'openai', created: 1_700_000_000 },
        { id: 'o3', owned_by: 'openai' },
        { id: 'ft:gpt-4.1-mini:organization:project', owned_by: 'organization' },
        { id: 'text-embedding-3-large' },
        { id: 'gpt-4o-transcribe' },
        { id: 'gpt-image-1' },
        { id: 'computer-use-preview' },
        { id: 'chatgpt-4o-latest' }
      ] })
    }) as typeof fetch)

    const result = await manager.listModels('openai', { forceRefresh: true })

    expect(result).toMatchObject({
      provider: 'openai', source: 'provider-api', providerState: 'connected',
      stale: false, truncated: false
    })
    expect(result.models.map(({ id }) => id)).toEqual([
      'ft:gpt-4.1-mini:organization:project', 'gpt-5', 'o3'
    ])
    expect(result.models[1]).toMatchObject({
      availability: 'unknown', ownedBy: 'openai',
      capabilities: {
        chat: { support: 'supported', evidence: 'maintained-metadata' },
        'tool-calling': { support: 'unknown', evidence: 'unknown' },
        vision: { support: 'unknown', evidence: 'unknown' }
      }
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/models')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer catalog-credential')
  })

  it.each([
    ['gpt-5.6-sol', true],
    ['gpt-4.1-mini', true],
    ['o4-mini', true],
    ['ft:gpt-4o-mini:org:name', true],
    ['gpt-4o-realtime-preview', false],
    ['gpt-5-search-api', false],
    ['o3-deep-research', false],
    ['codex-mini-latest', false],
    ['omni-moderation-latest', false]
  ])('classifies %s compatibility as %s', (model, expected) => {
    expect(isCompatibleOpenAIModelId(model)).toBe(expected)
  })
})

describe('Anthropic cloud model discovery', () => {
  it('paginates with after_id and only records capabilities exposed by provider metadata', async () => {
    const urls: string[] = []
    const manager = configuredManager((async (input, init) => {
      const url = new URL(String(input))
      urls.push(url.toString())
      expect(new Headers(init?.headers).get('x-api-key')).toBe('catalog-credential')
      expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01')
      if (!url.searchParams.has('after_id')) {
        return Response.json({
          data: [{
            id: 'claude-sonnet-test',
            display_name: 'Claude Sonnet Test',
            created_at: '2026-01-01T00:00:00Z',
            max_input_tokens: 200_000,
            max_tokens: 64_000,
            capabilities: {
              tool_use: { supported: true },
              image_input: { supported: false },
              structured_outputs: { supported: true }
            }
          }],
          has_more: true,
          last_id: 'page-one-last'
        })
      }
      expect(url.searchParams.get('after_id')).toBe('page-one-last')
      return Response.json({
        data: [
          { id: 'claude-haiku-test', display_name: 'Claude Haiku Test' },
          { id: 'not-a-claude-model', display_name: 'Ignore me' }
        ],
        has_more: false
      })
    }) as typeof fetch)

    const result = await manager.listModels('anthropic', { forceRefresh: true })

    expect(urls).toHaveLength(2)
    expect(result.models.map(({ id }) => id)).toEqual(['claude-haiku-test', 'claude-sonnet-test'])
    const sonnet = result.models.find(({ id }) => id === 'claude-sonnet-test')
    expect(sonnet).toMatchObject({
      displayName: 'Claude Sonnet Test',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: {
        chat: { support: 'supported', evidence: 'maintained-metadata' },
        'tool-calling': { support: 'supported', evidence: 'provider-api' },
        vision: { support: 'unsupported', evidence: 'provider-api' },
        'structured-output': { support: 'supported', evidence: 'provider-api' },
        streaming: { support: 'unknown', evidence: 'unknown' },
        'large-context': { support: 'supported', evidence: 'provider-api' },
        coding: { support: 'unknown', evidence: 'unknown' }
      }
    })
  })

  it('stops at the configured page bound and reports truncation honestly', async () => {
    let requests = 0
    const manager = configuredManager((async () => {
      requests++
      return Response.json({
        data: [{ id: `claude-page-${requests}`, display_name: `Claude Page ${requests}` }],
        has_more: true,
        last_id: `last-${requests}`
      })
    }) as typeof fetch, { maxPages: 2 })

    const result = await manager.listModels('anthropic', { forceRefresh: true })

    expect(requests).toBe(2)
    expect(result.models).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })
})

describe('Gemini cloud model discovery', () => {
  it.each([
    ['gemini-3.5-flash', true],
    ['gemini-flash-latest', true],
    ['gemini-2.5-flash-image', false],
    ['gemini-3.1-flash-tts-preview', false],
    ['gemini-2.5-live-preview', false],
    ['text-embedding-004', false],
    ['antigravity-preview', false]
  ])('classifies %s as a text-chat compatible model: %s', (model, expected) => {
    expect(isCompatibleGoogleTextModelId(model)).toBe(expected)
  })

  it('orders current stable Gemini generations ahead of retired catalog entries', async () => {
    const manager = configuredManager((async () => Response.json({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest', supportedGenerationMethods: ['generateContent'] }
      ]
    })) as typeof fetch)

    expect((await manager.listModels('google', { forceRefresh: true })).models.map((model) => model.id)).toEqual([
      'gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash'
    ])
  })

  it('paginates, keeps generateContent models, normalizes resource names, and deduplicates', async () => {
    const urls: string[] = []
    const manager = configuredManager((async (input, init) => {
      const url = new URL(String(input))
      urls.push(url.toString())
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('catalog-credential')
      if (!url.searchParams.has('pageToken')) {
        return Response.json({
          models: [
            {
              name: 'models/gemini-flash-test',
              displayName: 'Gemini Flash Test',
              description: 'A test model.',
              inputTokenLimit: 1_000_000,
              outputTokenLimit: 64_000,
              supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
            },
            {
              name: 'models/text-embedding-test',
              supportedGenerationMethods: ['embedContent']
            }
          ],
          nextPageToken: 'second-page'
        })
      }
      expect(url.searchParams.get('pageToken')).toBe('second-page')
      return Response.json({
        models: [
          {
            name: 'models/gemini-flash-test',
            displayName: 'Duplicate',
            supportedGenerationMethods: ['generateContent']
          },
          {
            name: 'models/gemini-pro-test',
            displayName: 'Gemini Pro Test',
            inputTokenLimit: 32_000,
            supportedGenerationMethods: ['generateContent']
          }
        ]
      })
    }) as typeof fetch)

    const result = await manager.listModels('google', { forceRefresh: true })

    expect(urls).toHaveLength(2)
    expect(result.models.map(({ id }) => id)).toEqual(['gemini-flash-test', 'gemini-pro-test'])
    expect(result.models[0]).toMatchObject({
      displayName: 'Gemini Flash Test',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      capabilities: {
        chat: { support: 'supported', evidence: 'provider-api' },
        streaming: { support: 'supported', evidence: 'provider-api' },
        'large-context': { support: 'supported', evidence: 'provider-api' },
        'tool-calling': { support: 'unknown', evidence: 'unknown' },
        vision: { support: 'unknown', evidence: 'unknown' }
      }
    })
    expect(result.models[1]?.capabilities['large-context']).toMatchObject({
      support: 'unsupported', evidence: 'provider-api'
    })
  })
})

describe('fallback and failure states', () => {
  it.each(['openai', 'anthropic', 'google'] as const)(
    'returns an honest not-configured %s fallback without making a request',
    async (provider) => {
      let requests = 0
      const manager = new ModelCatalogManager({
        getCredential: async () => undefined,
        fetch: (async () => { requests++; return Response.json({}) }) as typeof fetch,
        now: () => 42
      })

      const result = await manager.listModels(provider)

      expect(requests).toBe(0)
      expect(result).toMatchObject({
        provider,
        source: 'maintained-fallback',
        providerState: 'not-configured',
        stale: false,
        checkedAt: 42
      })
      expect(result.models.length).toBeGreaterThan(0)
      expect(result.models.every((model) =>
        model.availability === 'unknown' &&
        model.capabilities['tool-calling'].support === 'unknown' &&
        model.capabilities.vision.support === 'unknown'
      )).toBe(true)
    }
  )

  it('distinguishes authentication failure and redacts the credential from errors', async () => {
    const manager = configuredManager((async () => new Response(
      JSON.stringify({ error: 'Rejected catalog-credential' }),
      { status: 401 }
    )) as typeof fetch)

    const result = await manager.listModels('openai', { forceRefresh: true })

    expect(result).toMatchObject({
      source: 'maintained-fallback',
      providerState: 'authentication-failed',
      stale: true
    })
    expect(result.message).not.toContain('catalog-credential')
    expect(result.message).toContain('••••')
  })

  it('returns an unavailable fallback when credential access itself fails', async () => {
    const manager = new ModelCatalogManager({
      getCredential: async () => { throw new Error('Keychain is locked') }
    })
    await expect(manager.listModels('google')).resolves.toMatchObject({
      source: 'maintained-fallback', providerState: 'unavailable', stale: true,
      message: expect.stringContaining('Keychain is locked')
    })
  })

  it('bounds provider response bytes instead of parsing an oversized payload', async () => {
    const manager = configuredManager((async () => new Response('x'.repeat(1_100))) as typeof fetch, {
      maxResponseBytes: 1_024
    })
    await expect(manager.listModels('openai', { forceRefresh: true })).resolves.toMatchObject({
      source: 'maintained-fallback', providerState: 'unavailable', stale: true,
      message: expect.stringContaining('exceeded 1024 bytes')
    })
  })
})

describe('catalog cache and request coordination', () => {
  it('writes an atomic mode-0600 cache, serves it fresh, then falls back to it after a failed refresh', async () => {
    const cachePath = await temporaryCache()
    let now = 1_000
    const first = configuredManager((async () => Response.json({ data: [{ id: 'gpt-5' }] })) as typeof fetch, {
      cachePath,
      cacheTtlMs: 100,
      now: () => now
    })
    await expect(first.listModels('openai', { forceRefresh: true })).resolves.toMatchObject({
      source: 'provider-api', fetchedAt: 1_000
    })
    expect((await fs.stat(cachePath)).mode & 0o777).toBe(0o600)

    let refreshes = 0
    const restarted = configuredManager((async () => {
      refreshes++
      throw new Error('network failed for catalog-credential')
    }) as typeof fetch, {
      cachePath,
      cacheTtlMs: 100,
      now: () => now
    })
    now = 1_050
    const fresh = await restarted.listModels('openai')
    expect(refreshes).toBe(0)
    expect(fresh).toMatchObject({
      source: 'cache', providerState: 'configured', stale: false, fetchedAt: 1_000
    })
    expect(fresh.models[0]).toMatchObject({ id: 'gpt-5', availability: 'unknown' })

    now = 1_101
    const stale = await restarted.listModels('openai')
    expect(refreshes).toBe(1)
    expect(stale).toMatchObject({
      source: 'cache', providerState: 'unavailable', stale: true, fetchedAt: 1_000
    })
    expect(stale.message).not.toContain('catalog-credential')
  })

  it('coalesces simultaneous refreshes independently for each provider', async () => {
    let openAIRequests = 0
    let googleRequests = 0
    let releaseOpenAI!: () => void
    const openAIReady = new Promise<void>((resolve) => { releaseOpenAI = resolve })
    const manager = new ModelCatalogManager({
      getCredential: async (provider) => `${provider}-credential`,
      fetch: (async (input) => {
        const url = String(input)
        if (url.includes('api.openai.com')) {
          openAIRequests++
          await openAIReady
          return Response.json({ data: [{ id: 'gpt-5' }] })
        }
        googleRequests++
        return Response.json({ models: [{
          name: 'models/gemini-test', supportedGenerationMethods: ['generateContent']
        }] })
      }) as typeof fetch
    })

    const first = manager.listModels('openai', { forceRefresh: true })
    const second = manager.listModels('openai', { forceRefresh: true })
    const google = manager.listModels('google', { forceRefresh: true })
    await expect(google).resolves.toMatchObject({ source: 'provider-api' })
    releaseOpenAI()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(openAIRequests).toBe(1)
    expect(googleRequests).toBe(1)
  })

  it('ignores a corrupt cache document and performs live discovery', async () => {
    const cachePath = await temporaryCache()
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, '{not valid JSON')
    let requests = 0
    const manager = configuredManager((async () => {
      requests++
      return Response.json({ data: [{ id: 'gpt-5-mini' }] })
    }) as typeof fetch, { cachePath })

    await expect(manager.listModels('openai')).resolves.toMatchObject({
      source: 'provider-api', providerState: 'connected'
    })
    expect(requests).toBe(1)
  })
})

describe('provider input validation', () => {
  it('rejects non-cloud providers before credential or network access', async () => {
    let credentials = 0
    const manager = new ModelCatalogManager({
      getCredential: async (_provider: CloudAIProviderId) => { credentials++; return undefined }
    })
    await expect(manager.listModels('ollama' as CloudAIProviderId)).rejects.toThrow(
      'supported cloud model provider'
    )
    expect(credentials).toBe(0)
  })
})
