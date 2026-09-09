import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactElement } from 'react'
import type { AIModel, AIModelPreferences } from '../../../shared/contracts'
import type { AIModelCatalogResult, AIModelDescriptor, CloudAIProviderId } from '../../../shared/model-contracts'
import { unknownModelCapabilities } from '../../../shared/model-contracts'

// Exercise the component's initialization and event handlers without a browser
// dependency. Effects run after each explicit render, just as in React.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  pending: [] as Array<() => void>,
  cleanups: new Map<number, () => void>()
}))

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const slot = hooks.cursor++
    if (!(slot in hooks.slots)) hooks.slots[slot] = typeof initial === 'function' ? initial() : initial
    return [hooks.slots[slot], (next: unknown) => {
      hooks.slots[slot] = typeof next === 'function' ? next(hooks.slots[slot]) : next
    }]
  },
  useRef(initial: unknown) {
    const slot = hooks.cursor++
    if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial }
    return hooks.slots[slot]
  },
  useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
    const slot = hooks.cursor++
    const previous = hooks.slots[slot] as unknown[] | undefined
    if (previous && dependencies.every((value, index) => Object.is(value, previous[index]))) return
    hooks.slots[slot] = dependencies
    hooks.pending.push(() => {
      hooks.cleanups.get(slot)?.()
      const cleanup = effect()
      if (cleanup) hooks.cleanups.set(slot, cleanup)
      else hooks.cleanups.delete(slot)
    })
  }
}))

import { AIChat } from './AIChat'

const defaults: ComponentProps<typeof AIChat> = {
  workspacePath: null, defaultProvider: 'ollama', defaultModel: '', openFiles: [],
  selectedCode: () => '', terminalOutput: '', problems: '', gitChanges: '', permission: 'ask',
  prepareWorkspace: async () => {}, onReviewProposal: () => {}, onRunAgentCommand: () => {}, onOpenSettings: () => {}
}

function render(overrides: Partial<typeof defaults> = {}): ReactElement {
  hooks.cursor = 0
  const result = AIChat({ ...defaults, ...overrides })
  for (const effect of hooks.pending.splice(0)) effect()
  return result
}

function find(node: unknown, label: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const item of node) { const result = find(item, label); if (result) return result }
  } else if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as ReactElement<Record<string, unknown>>).props
    if (props['aria-label'] === label) return props
    return find(props.children, label)
  }
  return undefined
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function discovery() {
  const models = deferred<AIModel[]>()
  const preferences = deferred<AIModelPreferences>()
  const cloud = deferred<AIModelCatalogResult>()
  vi.stubGlobal('window', { omnicode: { ai: {
    models: () => models.promise,
    modelPreferences: () => preferences.promise,
    cloudModelCatalog: () => cloud.promise
  } } })
  return { models, preferences, cloud }
}

function cloudResult(provider: CloudAIProviderId, ids: string[]): AIModelCatalogResult {
  const models: AIModelDescriptor[] = ids.map((id) => ({
    id,
    displayName: id,
    provider,
    local: false,
    availability: 'available',
    capabilities: { ...unknownModelCapabilities(), chat: { support: 'supported', evidence: 'provider-api' } },
    metadataSource: 'provider-api'
  }))
  return { provider, models, fetchedAt: 0, checkedAt: 0, stale: false, truncated: false, source: 'provider-api', providerState: 'connected', message: 'Connected.' }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.pending = []; hooks.cleanups.clear() })
afterEach(() => { for (const cleanup of hooks.cleanups.values()) cleanup(); vi.unstubAllGlobals() })

describe('AIChat provider and model initialization', () => {
  it('applies changed workspace provider/model together without waiting for Ollama', () => {
    discovery()
    render()
    const cloud = { defaultProvider: 'google' as const, defaultModel: 'gemini-3.5-flash' }
    render(cloud)
    const tree = render(cloud)
    expect(find(tree, 'AI provider')?.value).toBe('google')
    expect(find(tree, 'AI model')?.value).toBe('gemini-3.5-flash')
    expect(find(tree, 'AI model name')).toBeUndefined()
  })

  it('does not apply stale local discovery after workspace defaults switch to cloud', async () => {
    const pending = discovery()
    render()
    const cloud = { defaultProvider: 'anthropic' as const, defaultModel: 'claude-sonnet-5' }
    render(cloud)
    pending.models.resolve([{ id: 'local:latest', name: 'Local', provider: 'ollama', local: true }])
    pending.preferences.resolve({ selectedModel: 'local:latest' })
    await flush()
    const tree = render(cloud)
    expect(find(tree, 'AI provider')?.value).toBe('anthropic')
    expect(find(tree, 'AI model')?.value).toBe('claude-sonnet-5')
  })

  it('loads cloud models from the provider catalog when the user switches providers', async () => {
    const pending = discovery()
    const tree = render()
    const change = find(tree, 'AI provider')?.onChange as (event: { target: { value: string } }) => void
    change({ target: { value: 'openai' } })
    pending.cloud.resolve(cloudResult('openai', ['gpt-current', 'gpt-fast']))
    pending.models.resolve([{ id: 'local:latest', name: 'Local', provider: 'ollama', local: true }])
    pending.preferences.resolve({ selectedModel: 'local:latest' })
    await flush()
    const next = render()
    expect(find(next, 'AI provider')?.value).toBe('openai')
    expect(find(next, 'AI model')?.value).toBe('gpt-current')
    expect(find(next, 'AI model name')).toBeUndefined()
  })

  it('preserves a selected local model while local discovery completes', async () => {
    const pending = discovery()
    render({ defaultModel: 'local:latest' })
    pending.models.resolve([{ id: 'local:latest', name: 'Local', provider: 'ollama', local: true }])
    pending.preferences.resolve({ selectedModel: 'local:latest' })
    await flush()
    expect(find(render({ defaultModel: 'local:latest' }), 'AI model')?.value).toBe('local:latest')
  })

  it('handles local discovery failure and keeps cloud defaults usable', async () => {
    const pending = discovery()
    const cloud = { defaultProvider: 'google' as const, defaultModel: '' }
    render(cloud)
    pending.models.reject(new Error('Ollama is unavailable'))
    pending.preferences.resolve({})
    pending.cloud.resolve(cloudResult('google', ['gemini-current']))
    await flush()
    const tree = render(cloud)
    expect(find(tree, 'AI provider')?.value).toBe('google')
    expect(find(tree, 'AI model')?.value).toBe('gemini-current')
  })
})
