import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { HardwareInfo } from '../../shared/contracts'
import type { ToolDescriptor } from '../../shared/tool-contracts'
import { AIManager } from './ai-manager'
import { CodeAgentToolService } from './code-agent-tool-service'
import { CredentialManager } from './credential-manager'
import { DiffManager } from './diff-manager'
import type { DevServerManager } from './dev-server-manager'
import { FileSystemManager } from './filesystem-manager'
import type { GitManager } from './git-manager'
import type { TerminalManager } from './terminal-manager'
import { ToolRegistry } from './tool-registry'
import { WorkAgentManager } from './work-agent-manager'
import { WorkspaceIndexer } from './workspace-indexer'

const LIVE = process.env.OMNICODE_TEST_OLLAMA === '1'
const MODEL = process.env.OMNICODE_TEST_OLLAMA_MODEL?.trim() || 'phi3:mini'

const hardware = async (): Promise<HardwareInfo> => ({
  platform: process.platform,
  architecture: process.arch,
  appleSilicon: process.platform === 'darwin' && process.arch === 'arm64',
  cpuModel: 'live-test-host',
  logicalCores: 1,
  memoryBytes: 8 * 1024 ** 3,
  availableMemoryBytes: 4 * 1024 ** 3,
  metalSupported: process.platform === 'darwin'
})

const versionTool: ToolDescriptor = {
  id: 'workspace.version',
  name: 'Read project version',
  description: 'Return the exact package version for the current project.',
  connectorId: 'workspace',
  modes: ['work'],
  action: 'read',
  category: 'read',
  risk: 'low',
  reversible: true,
  externalSideEffect: false,
  confirmation: 'never',
  requiredScopes: [],
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
}

function codeTools(root: string): { registry: ToolRegistry; service: CodeAgentToolService } {
  const fileSystem = new FileSystemManager()
  fileSystem.setWorkspace(root)
  const service = new CodeAgentToolService({
    fileSystem,
    diffs: new DiffManager(fileSystem),
    terminals: { stopAgentCommands: async () => undefined } as unknown as TerminalManager,
    git: {} as GitManager,
    server: {} as DevServerManager
  })
  const registry = new ToolRegistry()
  service.register(registry)
  return { registry, service }
}

describe.runIf(LIVE)('real local Ollama integration', () => {
  it('detects the selected model and derives its declared capabilities', async () => {
    const ai = new AIManager(new CredentialManager(), new WorkspaceIndexer(), hardware)
    const status = await ai.ollamaStatus()
    const model = (await ai.models()).find((candidate) => candidate.id.toLowerCase() === MODEL.toLowerCase())

    expect(status).toMatchObject({ state: 'connected', available: true })
    expect(model).toBeDefined()
    expect(model?.modelCapabilities?.supportsStreaming).toBe(true)
    expect(model?.modelCapabilities?.supportsTools).toBe(true)
  }, 30_000)

  it('runs a genuine model-selected tool call and continuation through ToolRegistry', async () => {
    const ai = new AIManager(new CredentialManager(), new WorkspaceIndexer(), hardware)
    const registry = new ToolRegistry()
    registry.register(versionTool, async () => ({ version: '0.9.0' }))
    const manager = new WorkAgentManager(ai)
    const started = performance.now()
    const response = await manager.chat({
      provider: 'ollama',
      model: MODEL,
      messages: [{ role: 'user', content: 'Use the available tool to find the exact project version, then report it.' }]
    }, registry.list('work'), (request) => registry.execute(request, {
      accessLevel: 'read-only',
      approvalMode: 'ask',
      confirm: async () => { throw new Error('A read-only tool unexpectedly requested approval.') }
    }), { maxSteps: 4, maxToolCalls: 3 })
    const latencyMs = Math.round(performance.now() - started)

    expect(response.toolCallCount).toBeGreaterThanOrEqual(1)
    expect(response.content).toContain('0.9.0')
    console.info(JSON.stringify({ model: MODEL, latencyMs, toolCallCount: response.toolCallCount }))
  }, 120_000)

  it('streams a real local response without duplicating deltas', async () => {
    const ai = new AIManager(new CredentialManager(), new WorkspaceIndexer(), hardware)
    const deltas: string[] = []
    const started = performance.now()
    const response = await ai.streamChat({
      provider: 'ollama',
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: Omni local stream works' }]
    }, (delta) => deltas.push(delta))
    const latencyMs = Math.round(performance.now() - started)

    expect(response.content).toBe(deltas.join(''))
    expect(response.content.toLowerCase()).toContain('omni local stream works')
    console.info(JSON.stringify({ model: MODEL, latencyMs, chunks: deltas.length }))
  }, 120_000)

  it('uses the production file tools to inspect package.json without hallucinating the version', async () => {
    const ai = new AIManager(new CredentialManager(), new WorkspaceIndexer(), hardware)
    const { registry } = codeTools(process.cwd())
    const tools = registry.list('code').filter((tool) => tool.id === 'files.read')
    const response = await new WorkAgentManager(ai).chat({
      provider: 'ollama',
      model: MODEL,
      messages: [{ role: 'user', content: 'Read package.json with the available file tool, then report its exact version and npm script names. Use the tool; do not guess.' }]
    }, tools, (request) => registry.execute(request, {
      accessLevel: 'read-only', approvalMode: 'ask', confirm: async () => false
    }, { executionId: 'ollama-live-read' }), { mode: 'code', maxSteps: 6, maxToolCalls: 5 })

    console.info(JSON.stringify({ task: 'package-inspection', response }))
    expect(response.toolCallCount).toBeGreaterThanOrEqual(1)
    expect(response.content).toContain('0.9.0')
    expect(response.content).toContain('typecheck')
  }, 120_000)

  it('receives a real file-tool failure and recovers with a valid read', async () => {
    const ai = new AIManager(new CredentialManager(), new WorkspaceIndexer(), hardware)
    const { registry } = codeTools(process.cwd())
    const tools = registry.list('code').filter((tool) => tool.id === 'files.read')
    const response = await new WorkAgentManager(ai).chat({
      provider: 'ollama',
      model: MODEL,
      messages: [{ role: 'user', content: 'First try to read definitely-missing-omnicode-test.txt. After that tool reports its harmless error, recover by reading package.json and tell me the real version.' }]
    }, tools, (request) => registry.execute(request, {
      accessLevel: 'read-only', approvalMode: 'ask', confirm: async () => false
    }, { executionId: 'ollama-live-recovery' }), { mode: 'code', maxSteps: 6, maxToolCalls: 5 })

    console.info(JSON.stringify({ task: 'failure-recovery', response }))
    expect(response.toolActivities.some((activity) => activity.status === 'failed')).toBe(true)
    expect(response.toolActivities.some((activity) => activity.status === 'succeeded')).toBe(true)
    expect(response.content).toContain('0.9.0')
  }, 120_000)

  it('uses production file tools with normal approval to create, verify, and clean a temporary file task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omnicode-ollama-live-'))
    try {
      const ai = new AIManager(new CredentialManager(), new WorkspaceIndexer(), hardware)
      const { registry, service } = codeTools(root)
      const tools = registry.list('code').filter((tool) => tool.id === 'files.write' || tool.id === 'files.read')
      let approvals = 0
      const response = await new WorkAgentManager(ai).chat({
        provider: 'ollama',
        model: MODEL,
        messages: [{ role: 'user', content: "Create hello.txt containing exactly 'Omni local test', read it back with the file tool, then report the verified text." }]
      }, tools, (request) => registry.execute(request, {
        accessLevel: 'trusted',
        approvalMode: 'ask',
        confirm: async () => { approvals++; return true }
      }, { executionId: 'ollama-live-write' }), { mode: 'code', maxSteps: 6, maxToolCalls: 5 })

      console.info(JSON.stringify({ task: 'file-write', approvals, response }))
      expect(approvals).toBe(1)
      expect(response.toolCallCount).toBeGreaterThanOrEqual(2)
      expect(await readFile(path.join(root, 'hello.txt'), 'utf8')).toBe('Omni local test')
      expect(response.content).toContain('Omni local test')
      await service.cleanupTask('ollama-live-write')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
