import { describe, expect, it } from 'vitest'

import type { HardwareInfo } from '../../shared/contracts'
import type { ToolDescriptor } from '../../shared/tool-contracts'
import { AIManager } from './ai-manager'
import { CredentialManager } from './credential-manager'
import { WorkspaceIndexer } from './workspace-indexer'

const hardware = async (): Promise<HardwareInfo> => ({
  platform: 'darwin', architecture: 'arm64', appleSilicon: true, cpuModel: 'Test Mac',
  logicalCores: 8, memoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3,
  metalSupported: true
})

const tool: ToolDescriptor = {
  id: 'browser.open',
  name: 'Open web page',
  description: 'Open a secure public page.',
  connectorId: 'browser',
  modes: ['work'],
  action: 'read',
  category: 'read',
  risk: 'low',
  reversible: true,
  externalSideEffect: false,
  confirmation: 'never',
  requiredScopes: [],
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', format: 'https-url', maxLength: 2_048 } },
    required: ['url'],
    additionalProperties: false
  }
}

function manager(response: Record<string, unknown>, captured: Array<Record<string, unknown>>): AIManager {
  const credentials = { get: async () => 'secret-test-key' } as unknown as CredentialManager
  return new AIManager(credentials, new WorkspaceIndexer(), hardware, {
    fetch: (async (_input, init) => {
      captured.push(typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {})
      return Response.json(response)
    }) as typeof fetch
  })
}

const base = {
  model: 'provider-model',
  system: 'Use tools safely.',
  messages: [{ role: 'user' as const, content: 'Open example.com.' }],
  tools: [tool]
}

describe('AIManager tool turns', () => {
  it('normalizes OpenAI function calls back to fixed OmniCode tool IDs', async () => {
    const captured: Array<Record<string, unknown>> = []
    const ai = manager({ choices: [{ finish_reason: 'tool_calls', message: {
      tool_calls: [{ id: 'call-1', function: { name: 'omni_0_browser_open', arguments: '{"url":"https://example.com/"}' } }]
    } }] }, captured)

    await expect(ai.toolTurn({ provider: 'openai', ...base })).resolves.toMatchObject({
      calls: [{ callId: 'call-1', name: 'omni_0_browser_open', toolId: 'browser.open', input: { url: 'https://example.com/' } }]
    })
    expect(captured[0]?.tool_choice).toBe('auto')
    expect(JSON.stringify(captured[0]?.tools)).toContain('Open a secure public page.')
  })

  it('normalizes Anthropic tool_use blocks and sends prior results as tool_result data', async () => {
    const captured: Array<Record<string, unknown>> = []
    const ai = manager({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }, captured)
    const result = await ai.toolTurn({ provider: 'anthropic', ...base, messages: [
      ...base.messages,
      { role: 'assistant-tool', content: '', calls: [{ callId: 'call-a', name: 'omni_0_browser_open', toolId: 'browser.open', input: { url: 'https://example.com/' } }] },
      { role: 'tool', callId: 'call-a', name: 'omni_0_browser_open', content: '{"ok":true}' }
    ] })

    expect(result).toMatchObject({ content: 'Done.', calls: [] })
    expect(JSON.stringify(captured[0]?.messages)).toContain('tool_result')
    expect(JSON.stringify(captured[0]?.tools)).toContain('input_schema')
  })

  it('normalizes Gemini functionCall parts and sends prior functionResponse data', async () => {
    const firstRequest: Array<Record<string, unknown>> = []
    const first = manager({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: {
      id: 'google-call-1', name: 'omni_0_browser_open', args: { url: 'https://example.com/' }
    }, thoughtSignature: 'opaque-google-signature' }] } }] }, firstRequest)
    const turn = await first.toolTurn({ provider: 'google', ...base })
    expect(turn.calls[0]).toMatchObject({
      callId: 'google-call-1',
      toolId: 'browser.open',
      input: { url: 'https://example.com/' },
      providerState: {
        googleFunctionCallId: 'google-call-1',
        googleThoughtSignature: 'opaque-google-signature'
      }
    })
    expect(JSON.stringify(firstRequest[0]?.tools)).toContain('functionDeclarations')
    expect(JSON.stringify(firstRequest[0]?.tools)).not.toContain('additionalProperties')

    const secondRequest: Array<Record<string, unknown>> = []
    const second = manager({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Example Domain' }] } }] }, secondRequest)
    await second.toolTurn({ provider: 'google', ...base, messages: [
      ...base.messages,
      { role: 'assistant-tool', content: '', calls: turn.calls },
      { role: 'tool', callId: turn.calls[0]!.callId, name: turn.calls[0]!.name, content: '{"ok":true,"result":{"title":"Example Domain"}}' }
    ] })
    const contents = JSON.stringify(secondRequest[0]?.contents)
    expect(contents).toContain('functionResponse')
    expect(contents).toContain('"id":"google-call-1"')
    expect(contents).toContain('"thoughtSignature":"opaque-google-signature"')
  })

  it('supports Ollama tool calls through the same normalized contract', async () => {
    const captured: Array<Record<string, unknown>> = []
    const ai = new AIManager(new CredentialManager(), new WorkspaceIndexer(), hardware, {
      fetch: (async (_input, init) => {
        captured.push(typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {})
        return Response.json({ message: { content: '', tool_calls: [{ function: { name: 'omni_0_browser_open', arguments: { url: 'https://example.com/' } } }] } })
      }) as typeof fetch
    })
    await expect(ai.toolTurn({ provider: 'ollama', ...base })).resolves.toMatchObject({
      calls: [{ toolId: 'browser.open', input: { url: 'https://example.com/' } }]
    })
    expect(captured[0]?.stream).toBe(false)
  })

  it('uses Ollama-native arguments and tool_name fields on the result round', async () => {
    const captured: Array<Record<string, unknown>> = []
    const ai = new AIManager(new CredentialManager(), new WorkspaceIndexer(), hardware, {
      fetch: (async (_input, init) => {
        captured.push(typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {})
        return Response.json({ message: { content: 'Example Domain' }, done_reason: 'stop' })
      }) as typeof fetch
    })
    await ai.toolTurn({ provider: 'ollama', ...base, messages: [
      ...base.messages,
      { role: 'assistant-tool', content: '', calls: [{
        callId: 'local-call-1',
        name: 'omni_0_browser_open',
        toolId: 'browser.open',
        input: { url: 'https://example.com/' }
      }] },
      { role: 'tool', callId: 'local-call-1', name: 'omni_0_browser_open', content: '{"ok":true}' }
    ] })

    const messages = captured[0]?.messages as Array<Record<string, unknown>>
    const assistant = messages.find((message) => message.role === 'assistant')
    const result = messages.find((message) => message.role === 'tool')
    expect(assistant).toMatchObject({
      tool_calls: [{ function: { name: 'omni_0_browser_open', arguments: { url: 'https://example.com/' } } }]
    })
    expect(result).toMatchObject({ role: 'tool', tool_name: 'omni_0_browser_open', content: '{"ok":true}' })
    expect(result).not.toHaveProperty('tool_call_id')
  })

  it('never maps a model-invented function name onto a registered tool', async () => {
    const ai = manager({ choices: [{ message: { tool_calls: [{ id: 'call-x', function: { name: 'shell_exec', arguments: '{"command":"rm -rf /"}' } }] } }] }, [])
    const result = await ai.toolTurn({ provider: 'openai', ...base })
    expect(result.calls[0]).toMatchObject({ name: 'shell_exec', toolId: undefined })
  })
})
