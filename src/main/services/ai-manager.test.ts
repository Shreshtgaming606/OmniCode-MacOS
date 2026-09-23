import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AIManager,
  OllamaProgressParser,
  parseOllamaProgressLine,
  recommendationFor
} from './ai-manager'
import { CredentialManager, CredentialNotFoundError } from './credential-manager'
import { WorkspaceIndexer } from './workspace-indexer'

const GIBIBYTE = 1024 ** 3

interface CapturedCloudRequest {
  url: string
  method: string | undefined
  headers: Headers
  body: Record<string, unknown>
}

const TEST_HARDWARE = async () => ({
  platform: 'darwin' as const,
  architecture: 'arm64',
  appleSilicon: true,
  cpuModel: 'Test Mac',
  logicalCores: 8,
  memoryBytes: 16 * GIBIBYTE,
  availableMemoryBytes: 8 * GIBIBYTE,
  metalSupported: true
})

function cloudManager(
  responseBody: Record<string, unknown>,
  requests: CapturedCloudRequest[],
  credentialRequests: string[]
): AIManager {
  const credentials = {
    async get(provider: string) {
      credentialRequests.push(provider)
      return `secret-${provider}-key`
    }
  } as CredentialManager
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : {}
    })
    return new Response(JSON.stringify(responseBody), { status: 200 })
  }) as typeof fetch

  return new AIManager(
    credentials,
    new WorkspaceIndexer(),
    TEST_HARDWARE,
    { fetch: fetchMock }
  )
}

function storedCredentials(): CredentialManager {
  const values = new Map<string, string>()
  return new CredentialManager(async (args, stdin) => {
    if (args[0] === '-i') {
      const match = stdin?.match(/^-?add-generic-password -U -s com\.omnicode\.editor\.ai -a (openai|anthropic|google) -X ([a-f\d]+)\n$/u)
      if (!match) throw new Error('Unexpected interactive Keychain command.')
      values.set(match[1], Buffer.from(match[2], 'hex').toString('utf8'))
      return ''
    }
    const provider = args[args.indexOf('-a') + 1]
    if (args[0] === 'find-generic-password') {
      const value = values.get(provider)
      if (value === undefined) throw new Error('The specified item could not be found in the keychain.')
      return value
    }
    if (args[0] === 'delete-generic-password') {
      values.delete(provider)
      return ''
    }
    throw new Error('Unexpected Keychain command.')
  })
}

describe('recommendationFor', () => {
  const hardware = { memoryBytes: 16 * GIBIBYTE }

  it('assigns each hardware recommendation band at its boundary', () => {
    expect(recommendationFor(undefined, hardware)).toBe('Should Run')
    expect(recommendationFor(5.6 * GIBIBYTE, hardware)).toBe('Recommended')
    expect(recommendationFor(8.8 * GIBIBYTE, hardware)).toBe('Should Run')
    expect(recommendationFor(12.8 * GIBIBYTE, hardware)).toBe('May Run Slowly')
    expect(recommendationFor(12.9 * GIBIBYTE, hardware)).toBe('Not Recommended')
  })

  it('classifies the same model more conservatively on a lower-memory Mac', () => {
    const modelMemory = 6 * GIBIBYTE
    expect(recommendationFor(modelMemory, { memoryBytes: 32 * GIBIBYTE })).toBe('Recommended')
    expect(recommendationFor(modelMemory, { memoryBytes: 8 * GIBIBYTE })).toBe('May Run Slowly')
  })
})

describe('parseOllamaProgressLine', () => {
  it('normalizes byte progress and terminal success messages', () => {
    expect(parseOllamaProgressLine(
      '{"status":"downloading","digest":"sha256:abc","total":400,"completed":100}',
      'qwen2.5-coder:7b'
    )).toEqual({
      model: 'qwen2.5-coder:7b',
      status: 'downloading',
      digest: 'sha256:abc',
      completed: 100,
      total: 400,
      percent: 25,
      done: false,
      error: undefined
    })

    expect(parseOllamaProgressLine('{"status":"success"}', 'qwen2.5-coder:7b'))
      .toMatchObject({ percent: 100, done: true })
  })

  it('turns Ollama error records into terminal progress', () => {
    expect(parseOllamaProgressLine(
      '{"error":"model manifest not found"}',
      'missing:latest'
    )).toMatchObject({
      status: 'Download failed',
      done: true,
      error: 'model manifest not found'
    })
  })

  it('ignores malformed lines', () => {
    expect(parseOllamaProgressLine('not json', 'model')).toBeUndefined()
  })
})

describe('OllamaProgressParser', () => {
  it('parses NDJSON split across arbitrary chunks and flushes a final unterminated line', () => {
    const parser = new OllamaProgressParser('code-model:7b')

    expect(parser.push('{"status":"pulling manifest"}\n{"status":"down'))
      .toEqual([expect.objectContaining({ status: 'pulling manifest', done: false })])
    expect(parser.push('loading","total":10,"completed":5}\ninvalid\n{"status":'))
      .toEqual([expect.objectContaining({ status: 'downloading', percent: 50 })])
    expect(parser.push('"success"}')).toEqual([])
    expect(parser.finish()).toEqual([
      expect.objectContaining({ status: 'success', percent: 100, done: true })
    ])
  })
})

describe('AIManager model lifecycle', () => {
  it('merges Ollama memory state and sends explicit load and unload requests', async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      requests.push({ url, body })
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:3b', size: 2_000 }] }), { status: 200 })
      }
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:3b', size: 2_000, size_vram: 1_500 }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ done: true }), { status: 200 })
    }) as typeof fetch
    const manager = new AIManager(
      new CredentialManager(),
      new WorkspaceIndexer(),
      async () => ({
        platform: 'darwin', architecture: 'arm64', appleSilicon: true, cpuModel: 'Test Mac',
        logicalCores: 8, memoryBytes: 16 * GIBIBYTE, availableMemoryBytes: 8 * GIBIBYTE,
        metalSupported: true
      }),
      { fetch: fetchMock }
    )

    const model = (await manager.modelCatalog()).find((item) => item.id === 'qwen2.5-coder:3b')
    expect(model).toMatchObject({ installed: true, loaded: true, loadedSize: 1_500 })

    await manager.loadModel('qwen2.5-coder:3b')
    await manager.unloadModel('qwen2.5-coder:3b')
    const lifecycleBodies = requests.filter((request) => request.url.endsWith('/api/generate')).map((request) => request.body)
    expect(lifecycleBodies).toEqual([
      expect.objectContaining({ model: 'qwen2.5-coder:3b', keep_alive: -1 }),
      expect.objectContaining({ model: 'qwen2.5-coder:3b', keep_alive: 0 })
    ])
  })

  it.each([
    {
      installed: false,
      message: 'Ollama is not installed. Install it from Setup or Tools & Runtimes before using Local AI.'
    },
    {
      installed: true,
      message: 'Ollama is installed, but its local service is unavailable. Start Ollama and try again.'
    }
  ])('turns a failed local connection into a useful installed=$installed error', async ({ installed, message }) => {
    const manager = new AIManager(
      new CredentialManager(),
      new WorkspaceIndexer(),
      TEST_HARDWARE,
      { fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch }
    )
    manager.ollamaStatus = async () => ({ installed, available: false })

    await expect(manager.chat({
      provider: 'ollama',
      model: 'qwen2.5-coder:1.5b',
      messages: [{ role: 'user', content: 'Hello' }]
    })).rejects.toThrow(message)
  })

  it('preserves an Ollama HTTP diagnostic such as a missing model response', async () => {
    const manager = new AIManager(
      new CredentialManager(),
      new WorkspaceIndexer(),
      TEST_HARDWARE,
      {
        fetch: (async () => new Response(
          JSON.stringify({ error: 'model not found' }),
          { status: 404 }
        )) as typeof fetch
      }
    )

    await expect(manager.chat({
      provider: 'ollama',
      model: 'missing:latest',
      messages: [{ role: 'user', content: 'Hello' }]
    })).rejects.toThrow('AI provider returned 404: {"error":"model not found"}')
  })
})

describe('AIManager cloud providers', () => {
  const messages = [
    { role: 'system' as const, content: 'Be concise.' },
    { role: 'user' as const, content: 'Explain this function.' },
    { role: 'assistant' as const, content: 'Which function?' },
    { role: 'user' as const, content: 'The selected one.' }
  ]

  it('sends ranked multi-file workspace context while excluding unrelated secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-ai-context-'))
    try {
      await fs.writeFile(path.join(root, 'auth.ts'), "import { SESSION_TTL_MINUTES } from './config'\nimport { USER_TABLE } from './database'\nexport function createLoginSession() { return `${USER_TABLE}:${SESSION_TTL_MINUTES}` }\n")
      await fs.writeFile(path.join(root, 'config.ts'), 'export const SESSION_TTL_MINUTES = 47\n')
      await fs.writeFile(path.join(root, 'database.ts'), "export const USER_TABLE = 'nebula_accounts'\n")
      await fs.writeFile(path.join(root, 'unrelated.ts'), 'export const WEATHER_THEME = true\n')
      await fs.writeFile(path.join(root, '.env'), 'OMNICODE_TEST_SECRET=never-send-this\n')
      const requests: CapturedCloudRequest[] = []
      const manager = cloudManager({ choices: [{ message: { content: 'Context answer' } }] }, requests, [])
      await manager.index(root)

      const result = await manager.chat({
        provider: 'openai',
        model: 'gpt-5',
        workspacePath: root,
        attachWorkspaceContext: true,
        messages: [{
          role: 'user',
          content: 'Explain createLoginSession using SESSION_TTL_MINUTES and USER_TABLE.'
        }]
      })

      expect(result.contextFiles.map((file) => path.basename(file))).toEqual(expect.arrayContaining([
        'auth.ts', 'config.ts', 'database.ts'
      ]))
      const outbound = requests[0]?.body.messages as Array<{ role: string; content: string }>
      expect(outbound[0]?.role).toBe('system')
      expect(outbound[0]?.content).toContain('--- auth.ts ---')
      expect(outbound[0]?.content).toContain('--- config.ts ---')
      expect(outbound[0]?.content).toContain('--- database.ts ---')
      expect(outbound[0]?.content).not.toContain('OMNICODE_TEST_SECRET')
      expect(outbound[0]?.content).not.toContain('WEATHER_THEME')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { provider: 'openai' as const, header: 'authorization', prefix: 'Bearer ', response: { choices: [{ message: { content: 'Saved key works' } }] } },
    { provider: 'anthropic' as const, header: 'x-api-key', prefix: '', response: { content: [{ type: 'text', text: 'Saved key works' }] } },
    { provider: 'google' as const, header: 'x-goog-api-key', prefix: '', response: { candidates: [{ content: { parts: [{ text: 'Saved key works' }] } }] } }
  ])('uses the saved $provider credential in the next cloud request', async ({ provider, header, prefix, response }) => {
    const requests: CapturedCloudRequest[] = []
    const credentials = storedCredentials()
    const manager = new AIManager(
      credentials,
      new WorkspaceIndexer(),
      TEST_HARDWARE,
      {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requests.push({
            url: String(input),
            method: init?.method,
            headers: new Headers(init?.headers),
            body: typeof init?.body === 'string'
              ? JSON.parse(init.body) as Record<string, unknown>
              : {}
          })
          return new Response(JSON.stringify(response), { status: 200 })
        }) as typeof fetch
      }
    )

    await manager.setCredential(provider, `  saved-${provider}-key  `)
    await expect(manager.hasCredential(provider)).resolves.toBe(true)
    await expect(manager.chat({ provider, model: 'test-model', messages }))
      .resolves.toEqual({ content: 'Saved key works', contextFiles: [] })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get(header)).toBe(`${prefix}saved-${provider}-key`)
  })

  it('shapes an OpenAI chat-completions request and parses its first reply', async () => {
    const requests: CapturedCloudRequest[] = []
    const credentialRequests: string[] = []
    const manager = cloudManager({
      choices: [{ message: { content: 'OpenAI answer' } }]
    }, requests, credentialRequests)

    const result = await manager.chat({ provider: 'openai', model: 'gpt-5', messages })

    expect(result).toEqual({ content: 'OpenAI answer', contextFiles: [] })
    expect(credentialRequests).toEqual(['openai'])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.headers.get('content-type')).toBe('application/json')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer secret-openai-key')
    expect(requests[0]?.body).toEqual({ model: 'gpt-5', messages, store: false })
  })

  it('moves system messages into Anthropic system text and joins text response blocks', async () => {
    const requests: CapturedCloudRequest[] = []
    const credentialRequests: string[] = []
    const manager = cloudManager({
      content: [
        { type: 'text', text: 'First block' },
        { type: 'tool_use', name: 'ignored' },
        { type: 'text', text: 'Second block' }
      ]
    }, requests, credentialRequests)

    const result = await manager.chat({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'First instruction.' },
        ...messages
      ]
    })

    expect(result).toEqual({ content: 'First block\nSecond block', contextFiles: [] })
    expect(credentialRequests).toEqual(['anthropic'])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.headers.get('content-type')).toBe('application/json')
    expect(requests[0]?.headers.get('x-api-key')).toBe('secret-anthropic-key')
    expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(requests[0]?.body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: 'First instruction.\n\nBe concise.',
      messages: messages.filter((message) => message.role !== 'system')
    })
  })

  it('maps messages to Gemini contents and concatenates returned text parts', async () => {
    const requests: CapturedCloudRequest[] = []
    const credentialRequests: string[] = []
    const manager = cloudManager({
      candidates: [{ content: { parts: [{ text: 'Gemini ' }, { text: 'answer' }] } }]
    }, requests, credentialRequests)

    const result = await manager.chat({
      provider: 'google',
      model: 'gemini-3.5-flash',
      messages
    })

    expect(result).toEqual({ content: 'Gemini answer', contextFiles: [] })
    expect(credentialRequests).toEqual(['google'])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
    )
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.headers.get('content-type')).toBe('application/json')
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('secret-google-key')
    expect(requests[0]?.body).toEqual({
      systemInstruction: { parts: [{ text: 'Be concise.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Explain this function.' }] },
        { role: 'model', parts: [{ text: 'Which function?' }] },
        { role: 'user', parts: [{ text: 'The selected one.' }] }
      ]
    })
  })

  it('reports a genuinely absent provider credential without sending a request', async () => {
    let requestCount = 0
    const credentials = {
      async get() { throw new CredentialNotFoundError('google') }
    } as unknown as CredentialManager
    const manager = new AIManager(
      credentials,
      new WorkspaceIndexer(),
      TEST_HARDWARE,
      { fetch: (async () => { requestCount += 1; return new Response() }) as typeof fetch }
    )

    await expect(manager.chat({ provider: 'google', model: 'gemini-3.5-flash', messages }))
      .rejects.toThrow('No Google Gemini API key is stored. Add one in Settings → AI Providers.')
    expect(requestCount).toBe(0)
  })

  it('does not misreport an operational Keychain failure as a missing key', async () => {
    let requestCount = 0
    const credentials = {
      async get() { throw new Error('User interaction is not allowed.') }
    } as unknown as CredentialManager
    const manager = new AIManager(
      credentials,
      new WorkspaceIndexer(),
      TEST_HARDWARE,
      { fetch: (async () => { requestCount += 1; return new Response() }) as typeof fetch }
    )

    await expect(manager.chat({ provider: 'openai', model: 'gpt-5', messages }))
      .rejects.toThrow(
        'OmniCode could not read the OpenAI API key from macOS Keychain: User interaction is not allowed.'
      )
    expect(requestCount).toBe(0)
  })

  it.each(['openai', 'anthropic', 'google'] as const)('rejects an empty %s response instead of adding a blank assistant message', async (provider) => {
    const manager = cloudManager({}, [], [])
    await expect(manager.chat({ provider, model: 'test-model', messages })).rejects.toThrow('returned no text')
  })

  it.each([
    { provider: 'openai' as const, body: { choices: [{ finish_reason: 'content_filter', message: { content: null } }] }, reason: 'content_filter' },
    { provider: 'anthropic' as const, body: { stop_reason: 'refusal', content: [] }, reason: 'refusal' },
    { provider: 'google' as const, body: { promptFeedback: { blockReason: 'SAFETY' } }, reason: 'SAFETY' },
    { provider: 'google' as const, body: { candidates: [{ finishReason: 'RECITATION' }] }, reason: 'RECITATION' }
  ])('explains a blocked $provider reply ($reason)', async ({ provider, body, reason }) => {
    const manager = cloudManager(body, [], [])
    await expect(manager.chat({ provider, model: 'test-model', messages })).rejects.toThrow(reason)
  })

  it('preserves a provider refusal message as readable text', async () => {
    const manager = cloudManager({ choices: [{ message: { content: null, refusal: 'I cannot help with that request.' } }] }, [], [])
    await expect(manager.chat({ provider: 'openai', model: 'test-model', messages }))
      .resolves.toMatchObject({ content: 'I cannot help with that request.' })
  })

  it('omits Gemini thought parts and normalizes a pasted model name', async () => {
    const requests: CapturedCloudRequest[] = []
    const manager = cloudManager({ candidates: [{ content: { parts: [{ text: 'Internal notes', thought: true }, { text: 'Final answer' }] } }] }, requests, [])
    await expect(manager.chat({ provider: 'google', model: '  gemini-test  ', messages }))
      .resolves.toMatchObject({ content: 'Final answer' })
    expect(requests[0]?.url).toContain('/models/gemini-test:generateContent')
  })

  it.each([401, 403, 404, 429])('surfaces cloud HTTP %s as a failed request', async (status) => {
    const manager = new AIManager(storedCredentials(), new WorkspaceIndexer(), TEST_HARDWARE, {
      fetch: (async () => new Response(JSON.stringify({ error: { message: 'Provider diagnostic' } }), { status })) as typeof fetch
    })
    await manager.setCredential('google', 'test-key')
    await expect(manager.chat({ provider: 'google', model: 'test-model', messages })).rejects.toThrow(`AI provider returned ${status}`)
  })

  it.each([
    { provider: 'openai' as const, url: 'https://api.openai.com/v1/models', header: 'authorization', value: 'Bearer connection-key' },
    { provider: 'anthropic' as const, url: 'https://api.anthropic.com/v1/models?limit=1', header: 'x-api-key', value: 'connection-key' },
    { provider: 'google' as const, url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', header: 'x-goog-api-key', value: 'connection-key' }
  ])('authenticates the saved $provider key with its lightweight models endpoint', async ({ provider, url, header, value }) => {
    const credentials = storedCredentials()
    await credentials.set(provider, 'connection-key')
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const manager = new AIManager(credentials, new WorkspaceIndexer(), TEST_HARDWARE, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init })
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }) as typeof fetch
    })

    const result = await manager.testProviderConnection(provider)

    expect(result).toMatchObject({ provider, state: 'connected', stored: true })
    expect(result.checkedAt).toBeTruthy()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(url)
    expect(requests[0]?.init?.method).toBe('GET')
    expect(new Headers(requests[0]?.init?.headers).get(header)).toBe(value)
    if (provider === 'anthropic') {
      expect(new Headers(requests[0]?.init?.headers).get('anthropic-version')).toBe('2023-06-01')
    }
  })

  it.each([401, 403])('distinguishes an HTTP %s authentication failure from stored state', async (status) => {
    const credentials = storedCredentials()
    await credentials.set('google', 'invalid-key')
    const manager = new AIManager(credentials, new WorkspaceIndexer(), TEST_HARDWARE, {
      fetch: (async () => new Response('', { status })) as typeof fetch
    })

    await expect(manager.testProviderConnection('google')).resolves.toMatchObject({
      state: 'authentication-failed', stored: true, message: expect.stringContaining(`HTTP ${status}`)
    })
    await expect(manager.hasCredential('google')).resolves.toBe(true)
  })

  it('reports missing, rate-limited, and unreachable providers without exposing the key', async () => {
    let requestCount = 0
    const missing = new AIManager({
      async get() { throw new CredentialNotFoundError('openai') }
    } as unknown as CredentialManager, new WorkspaceIndexer(), TEST_HARDWARE, {
      fetch: (async () => { requestCount += 1; return new Response() }) as typeof fetch
    })
    await expect(missing.testProviderConnection('openai')).resolves.toMatchObject({ state: 'not-configured', stored: false })
    expect(requestCount).toBe(0)

    const credentials = storedCredentials()
    await credentials.set('anthropic', 'private-connection-key')
    const rateLimited = new AIManager(credentials, new WorkspaceIndexer(), TEST_HARDWARE, {
      fetch: (async () => new Response('', { status: 429 })) as typeof fetch
    })
    await expect(rateLimited.testProviderConnection('anthropic')).resolves.toMatchObject({ state: 'unavailable', stored: true })

    const unreachable = new AIManager(credentials, new WorkspaceIndexer(), TEST_HARDWARE, {
      fetch: (async () => { throw new Error('socket failed for private-connection-key') }) as typeof fetch
    })
    const result = await unreachable.testProviderConnection('anthropic')
    expect(result).toMatchObject({ state: 'unavailable', stored: true })
    expect(result.message).not.toContain('private-connection-key')
  })
})
