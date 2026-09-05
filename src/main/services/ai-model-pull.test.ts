import { describe, expect, it } from 'vitest'
import { AIManager } from './ai-manager'
import { CredentialManager } from './credential-manager'
import { WorkspaceIndexer } from './workspace-indexer'
import type { OllamaPullProgress } from '../../shared/contracts'

function manager(fetchMock: typeof fetch): AIManager {
  return new AIManager(new CredentialManager(), new WorkspaceIndexer(), async () => ({
    platform: 'darwin', architecture: 'x64', appleSilicon: false,
    cpuModel: 'Test Mac', logicalCores: 4, memoryBytes: 16 * 1024 ** 3,
    availableMemoryBytes: 8 * 1024 ** 3, metalSupported: true
  }), { fetch: fetchMock })
}

describe('setup model download lifecycle', () => {
  it('streams real byte progress and requires a final success before completion', async () => {
    const updates: OllamaPullProgress[] = []
    const requests: string[] = []
    const ai = manager((async (url, init) => {
      requests.push(String(url))
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'qwen2.5-coder:1.5b', stream: true })
      return new Response(new ReadableStream({ start(controller) {
        for (const chunk of ['{"status":"pulling manifest"}\n', '{"status":"downloading","total":200,"completed":', '100}\n{"status":"success"}']) {
          controller.enqueue(new TextEncoder().encode(chunk))
        }
        controller.close()
      } }))
    }) as typeof fetch)
    await expect(ai.pullModel('qwen2.5-coder:1.5b', (progress) => updates.push(progress)))
      .resolves.toEqual({ model: 'qwen2.5-coder:1.5b', cancelled: false })
    expect(requests).toEqual(['http://127.0.0.1:11434/api/pull'])
    expect(updates).toContainEqual(expect.objectContaining({ percent: 50, done: false }))
    expect(updates.at(-1)).toMatchObject({ percent: 100, done: true })
    expect(ai.modelPulls()).toEqual([])
  })

  it.each([
    ['{"status":"downloading","total":200,"completed":100}\n', /before reporting success/],
    ['{"error":"Not enough disk space"}\n', /Not enough disk space/]
  ])('does not report success for an incomplete or failed stream', async (body, error) => {
    const updates: OllamaPullProgress[] = []
    const ai = manager((async () => new Response(body)) as typeof fetch)
    await expect(ai.pullModel('qwen2.5-coder:1.5b', (progress) => updates.push(progress))).rejects.toThrow(error)
    expect(updates.at(-1)).toMatchObject({ done: true, status: 'Download failed' })
    expect(ai.modelPulls()).toEqual([])
  })

  it('cancels the active network request, rejects duplicate pulls, and permits retry', async () => {
    let attempts = 0
    const ai = manager((async (_url, init) => {
      attempts++
      if (attempts > 1) return new Response('{"status":"success"}\n')
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }) as typeof fetch)
    const updates: OllamaPullProgress[] = []
    const first = ai.pullModel('qwen2.5-coder:1.5b', (progress) => updates.push(progress))
    expect(ai.modelPulls()).toHaveLength(1)
    await expect(ai.pullModel('qwen2.5-coder:1.5b')).rejects.toThrow('already downloading')
    expect(ai.cancelModelPull('qwen2.5-coder:1.5b')).toBe(true)
    await expect(first).resolves.toMatchObject({ cancelled: true })
    expect(updates.at(-1)).toMatchObject({ done: true, cancelled: true })
    expect(ai.modelPulls()).toEqual([])
    expect(ai.cancelModelPull('qwen2.5-coder:1.5b')).toBe(false)
    await expect(ai.pullModel('qwen2.5-coder:1.5b')).resolves.toMatchObject({ cancelled: false })
  })
})
