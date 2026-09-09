import { describe, expect, it, vi } from 'vitest'

import type { AIProviderId } from '../../shared/contracts'
import { AIManager } from './ai-manager'
import type { CredentialManager } from './credential-manager'
import { WorkspaceIndexer } from './workspace-indexer'

const TEST_HARDWARE = async () => ({
  platform: 'darwin', architecture: 'arm64', appleSilicon: true, cpuModel: 'Test Mac',
  logicalCores: 8, memoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3,
  metalSupported: true
})

function responseStream(chunks: string[], contentType: string): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  }), { status: 200, headers: { 'Content-Type': contentType } })
}

function manager(fetchMock: typeof fetch): AIManager {
  const credentials = { get: async () => 'secret-test-key' } as unknown as CredentialManager
  return new AIManager(credentials, new WorkspaceIndexer(), TEST_HARDWARE, { fetch: fetchMock })
}

async function streamed(
  provider: AIProviderId,
  fetchMock: typeof fetch
): Promise<{ content: string; deltas: string[]; request: Record<string, unknown> }> {
  const deltas: string[] = []
  let body: Record<string, unknown> = {}
  const inspectingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    return fetchMock(input, init)
  }) as typeof fetch
  const response = await manager(inspectingFetch).streamChat({
    provider,
    model: provider === 'ollama' ? 'local-model' : 'cloud-model',
    messages: [{ role: 'user', content: 'Say hello.' }]
  }, (delta) => deltas.push(delta))
  return { content: response.content, deltas, request: body }
}

describe('AIManager real streaming transports', () => {
  it('parses OpenAI SSE deltas split across network chunks', async () => {
    const result = await streamed('openai', (async () => responseStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ], 'text/event-stream')) as typeof fetch)

    expect(result).toMatchObject({ content: 'Hello', deltas: ['Hel', 'lo'] })
    expect(result.request).toMatchObject({ stream: true })
  })

  it('parses Anthropic text-delta events', async () => {
    const result = await streamed('anthropic', (async () => responseStream([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    ], 'text/event-stream')) as typeof fetch)

    expect(result).toMatchObject({ content: 'Hello', deltas: ['Hello'] })
    expect(result.request).toMatchObject({ stream: true })
  })

  it('parses Gemini SSE and excludes provider thought parts', async () => {
    const result = await streamed('google', (async (input) => {
      expect(String(input)).toContain(':streamGenerateContent?alt=sse')
      return responseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"hidden","thought":true},{"text":"Hel"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"lo"}]}}]}\n\n'
      ], 'text/event-stream')
    }) as typeof fetch)

    expect(result).toMatchObject({ content: 'Hello', deltas: ['Hel', 'lo'] })
  })

  it('parses Ollama NDJSON deltas', async () => {
    const result = await streamed('ollama', (async () => responseStream([
      '{"message":{"content":"Hel"},"done":false}\n{"message":{"content":"lo',
      '"},"done":false}\n{"message":{"content":""},"done":true,"done_reason":"stop"}\n'
    ], 'application/x-ndjson')) as typeof fetch)

    expect(result).toMatchObject({ content: 'Hello', deltas: ['Hel', 'lo'] })
    expect(result.request).toMatchObject({ stream: true })
  })

  it('aborts an in-flight provider request without producing a fake completion', async () => {
    const observedAbort = vi.fn()
    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        observedAbort()
        reject(init.signal.reason)
        return
      }
      init?.signal?.addEventListener('abort', () => {
        observedAbort()
        reject(new DOMException('Generation cancelled.', 'AbortError'))
      }, { once: true })
    })) as typeof fetch
    const controller = new AbortController()
    const operation = manager(fetchMock).streamChat({
      provider: 'google', model: 'cloud-model', messages: [{ role: 'user', content: 'Wait.' }]
    }, vi.fn(), controller.signal)
    controller.abort(new DOMException('Generation cancelled.', 'AbortError'))

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    expect(observedAbort).toHaveBeenCalledOnce()
  })
})
