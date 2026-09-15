import { describe, expect, it } from 'vitest'

import type { CodeAgentEvent, CodeAgentTask } from '../../../shared/code-agent-contracts'
import { buildAgentFinalReport, parseAgentPlan, relativeAgentPath, visibleAgentEvents } from './AgentMode'

describe('Agent plan safety', () => {
  it('parses a fenced plan but keeps changes as review-only relative paths', () => {
    expect(parseAgentPlan(`\`\`\`json
      {
        "summary": "Add an audit page",
        "plan": ["Read existing navigation", "Create the page"],
        "changes": [{"kind":"create","path":"pages/audit.md","content":"# Audit\\n"}],
        "commands": [{"command":"npm test","reason":"Verify the project"}]
      }
    \`\`\``)).toEqual({
      summary: 'Add an audit page',
      plan: ['Read existing navigation', 'Create the page'],
      changes: [{ kind: 'create', path: 'pages/audit.md', content: '# Audit\n' }],
      commands: [{ command: 'npm test', reason: 'Verify the project' }]
    })
  })

  it.each(['/tmp/escaped.txt', '../escaped.txt', 'nested/../../escaped.txt', '', 42])(
    'rejects an unsafe proposed path: %s',
    (candidate) => expect(() => relativeAgentPath(candidate)).toThrow()
  )

  it('limits plan and command counts and rejects oversized file batches', () => {
    const changes = Array.from({ length: 51 }, (_, index) => ({
      kind: 'create', path: `file-${index}.txt`, content: 'review me'
    }))
    expect(() => parseAgentPlan(JSON.stringify({ changes }))).toThrow('more than 50 files')

    const parsed = parseAgentPlan(JSON.stringify({
      plan: Array.from({ length: 30 }, (_, index) => `Step ${index}`),
      changes: [{ kind: 'create', path: 'safe.txt', content: 'safe' }],
      commands: Array.from({ length: 20 }, (_, index) => ({ command: `npm run check-${index}` }))
    }))
    expect(parsed.plan).toHaveLength(20)
    expect(parsed.commands).toHaveLength(10)
  })

  it('rejects malformed or incomplete change records', () => {
    expect(() => parseAgentPlan('not JSON')).toThrow('valid agent plan')
    expect(() => parseAgentPlan('{"changes":[{"kind":"modify","path":"safe.txt"}]}')).toThrow('incomplete')
  })

  it('shows every observable action in Glasses Mode and only consequential updates in Standard Mode', () => {
    const events = [
      { id: '1', taskId: 'task', timestamp: 1, kind: 'file', status: 'succeeded', title: 'Read', summary: 'Read file.' },
      { id: '2', taskId: 'task', timestamp: 2, kind: 'terminal', status: 'waiting', title: 'Run', summary: 'Approval required.' },
      { id: '3', taskId: 'task', timestamp: 3, kind: 'test', status: 'failed', title: 'Test', summary: 'Failed.' },
      { id: '4', taskId: 'task', timestamp: 4, kind: 'result', status: 'succeeded', title: 'Done', summary: 'Complete.' },
      { id: '5', taskId: 'task', timestamp: 5, kind: 'plan', status: 'succeeded', title: 'Plan updated', summary: 'Retest after the fix.' }
    ] satisfies CodeAgentEvent[]
    expect(visibleAgentEvents(events, 'glasses')).toEqual(events)
    expect(visibleAgentEvents(events, 'standard').map((event) => event.id)).toEqual(['2', '3', '4', '5'])
  })

  it('derives a truthful final report from persisted actions and failures', () => {
    const task = {
      id: 'task', title: 'Fix tests', provider: 'google', model: 'gemini-test', approvalMode: 'ask', visibility: 'glasses', focusBehavior: 'automatic',
      status: 'completed', createdAt: 1, updatedAt: 5, completedAt: 5, actionCount: 5, resultSummary: 'Fixed the validator and verified the suite.',
      events: [
        { id: '1', taskId: 'task', timestamp: 1, kind: 'file', status: 'succeeded', title: 'Write file', summary: 'Saved change.', toolId: 'files.write', relativePath: 'src/auth.ts' },
        { id: '2', taskId: 'task', timestamp: 2, kind: 'test', status: 'failed', title: 'Run tests', summary: '2 tests failed.', command: 'npm test' },
        { id: '3', taskId: 'task', timestamp: 3, kind: 'plan', status: 'succeeded', title: 'Plan updated', summary: 'Fix the shared validator.' },
        { id: '4', taskId: 'task', timestamp: 4, kind: 'test', status: 'succeeded', title: 'Run tests', summary: '24 tests passed.', command: 'npm test' },
        { id: '5', taskId: 'task', timestamp: 5, kind: 'result', status: 'succeeded', title: 'Task completed', summary: 'Verified.' }
      ]
    } satisfies CodeAgentTask

    expect(buildAgentFinalReport(task)).toMatchObject({
      whatIDid: 'Fixed the validator and verified the suite.',
      changes: ['Write file: src/auth.ts'],
      tests: ['$ npm test'],
      results: ['Failed: 2 tests failed.', 'Passed: 24 tests passed.', 'Passed: Verified.'],
      problems: ['2 tests failed.'],
      planChanges: ['Plan updated: Fix the shared validator.'],
      remaining: ['None reported by the Agent.']
    })
  })
})
