import { expect, test } from 'bun:test'
import { overview } from './overview.ts'

const agent = (id: string, status = 'idle', queued = 0) => ({
  id,
  role: id,
  status,
  queued,
  task: 'main',
  model: 'fixture',
})

test('groups actual agent state and preserves queue counts without claiming idle work completed', () => {
  const result = overview({
    agents: [
      agent('architect', 'working', 2),
      agent('coder', 'idle', 1),
      agent('tester', 'stopped'),
    ],
    lines: [],
  })
  expect(result.counts).toEqual({
    total: 3,
    working: 1,
    approval: 0,
    stopped: 1,
    idle: 1,
    queued: 3,
  })
  expect(result.groups.idle.map((row) => row.id)).toEqual(['coder'])
  expect(result.tasks).toEqual(['main'])
  expect(result).not.toHaveProperty('progress')
  expect(result).not.toHaveProperty('completed')
  expect(result.attention).toEqual([])
})

test('requires action only for actual approval or stopped agent whose latest activity is error', () => {
  const pending = {
    id: 'p1',
    agentId: 'architect',
    because: 'Approval needed',
    summary: 'Run command',
    answers: [],
  }
  const result = overview({
    agents: [
      agent('architect', 'working'),
      agent('coder'),
      agent('tester', 'stopped'),
      agent('reviewer', 'working'),
    ],
    pending,
    lines: [
      { agentId: 'coder', kind: 'error', text: 'Old idle error' },
      { agentId: 'reviewer', kind: 'error', text: 'Old working error' },
      { agentId: 'tester', kind: 'error', text: 'Current failed request' },
    ],
  })
  expect(result.groups.approval.map((row) => row.id)).toEqual(['architect'])
  expect(result.attention).toEqual([
    { agentId: 'architect', kind: 'approval', pending },
    { agentId: 'tester', kind: 'stopped', error: 'Current failed request' },
  ])
  expect(result.counts.working).toBe(2)
})

test('shows meaningful public activity without reasoning or promoting a stale stopped error', () => {
  const text = 'Full useful answer '.repeat(100)
  const result = overview({
    agents: [agent('tester', 'stopped')],
    lines: [
      { agentId: 'tester', kind: 'error', text: 'Recovered error' },
      { agentId: 'tester', kind: 'say', text },
      { agentId: 'tester', kind: 'thinking', text: 'Private reasoning' },
      { agentId: 'tester', kind: 'note', text: 'Incidental note' },
    ],
  })
  expect(result.crew[0]?.latest).toEqual({ kind: 'say', text })
  expect(result.attention).toEqual([])
  expect(JSON.stringify(result)).not.toContain('Private reasoning')
})

test('identifies only the first recorded architect request as starting context', () => {
  const result = overview({
    agents: [agent('architect'), agent('coder')],
    lines: [
      { agentId: 'coder', kind: 'ask', text: 'Delegated code task' },
      { agentId: 'architect', kind: 'ask', text: 'Original user request' },
      { agentId: 'architect', kind: 'ask', text: 'Later steering' },
    ],
  })
  expect(result.startingRequest).toEqual({ agentId: 'architect', text: 'Original user request' })
  expect(result.lead?.id).toBe('architect')
  expect(overview({ agents: [], lines: [] }).startingRequest).toBeUndefined()
  expect(overview({ agents: [], lines: [] }).counts.total).toBe(0)
})

test('keeps the latest actual assignment separate from subsequent technical activity', () => {
  const assignment = '← architect: Verify the world boundary\nand preserve the evidence.'
  const result = overview({
    agents: [agent('tester', 'working')],
    lines: [
      { agentId: 'tester', kind: 'ask', text: 'Initial assignment' },
      { agentId: 'tester', kind: 'note', text: assignment },
      { agentId: 'tester', kind: 'note', text: '→ coder: Please check the code' },
      { agentId: 'tester', kind: 'tool', text: 'bash rg -n escape src' },
    ],
  })
  expect(result.crew[0]?.assignment).toEqual({ kind: 'note', text: assignment })
  expect(result.crew[0]?.latest).toEqual({ kind: 'tool', text: 'bash rg -n escape src' })
})

test('offers the current agent as a next action without inventing an architect starting request', () => {
  const result = overview({
    agents: [agent('coder'), agent('tester')],
    target: 'tester',
    lines: [{ agentId: 'tester', kind: 'ask', text: 'A local task' }],
  })
  expect(result.lead?.id).toBe('tester')
  expect(result.startingRequest).toBeUndefined()
  expect(overview({ agents: [agent('coder')], lines: [] }).lead?.id).toBe('coder')
})

test('preserves existing task context when the bounded journal no longer contains its starting request', () => {
  const text = 'Phase one checks passed. Waiting for the next assignment.'
  const result = overview({
    agents: [agent('architect')],
    lines: [
      { agentId: 'architect', kind: 'say', text },
      { agentId: 'architect', kind: 'tool', text: 'read status.json' },
    ],
  })
  expect(result.hasHistory).toBe(true)
  expect(result.startingRequest).toBeUndefined()
  expect(result.leadUpdate).toEqual({ agentId: 'architect', text })
  expect(result.lead?.latest?.kind).toBe('tool')
  expect(overview({ agents: [agent('architect')], lines: [] }).hasHistory).toBe(false)
})
