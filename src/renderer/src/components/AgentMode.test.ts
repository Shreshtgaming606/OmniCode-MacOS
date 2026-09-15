import { describe, expect, it } from 'vitest'

import type { CodeAgentEvent } from '../../../shared/code-agent-contracts'
import { parseAgentPlan, relativeAgentPath, visibleAgentEvents } from './AgentMode'

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
      { id: '4', taskId: 'task', timestamp: 4, kind: 'result', status: 'succeeded', title: 'Done', summary: 'Complete.' }
    ] satisfies CodeAgentEvent[]
    expect(visibleAgentEvents(events, 'glasses')).toEqual(events)
    expect(visibleAgentEvents(events, 'standard').map((event) => event.id)).toEqual(['2', '3', '4'])
  })
})
