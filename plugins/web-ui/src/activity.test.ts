import { expect, test } from 'bun:test'
import { activityLog } from './activity.ts'

test('keeps public events chronological and excludes private reasoning', () => {
  const result = activityLog([
    { agentId: 'a', kind: 'ask', text: 'Build' },
    { agentId: 'a', kind: 'thinking', text: 'Private' },
    { agentId: 'a', kind: 'tool', text: 'read src' },
    { agentId: 'a', kind: 'say', text: 'Result' },
  ])
  expect(result.entries.map((entry) => [entry.index, entry.category, entry.text])).toEqual([
    [0, 'messages', 'Build'],
    [2, 'tools', 'read src'],
    [3, 'messages', 'Result'],
  ])
  expect(JSON.stringify(result)).not.toContain('Private')
  expect(result.entries[0]).not.toHaveProperty('timestamp')
})

test('shows one complete handoff with explicit source and recipient and filters either endpoint', () => {
  const text = `${'A'.repeat(120)}\nSecond line`
  const lines = [
    { agentId: 'architect', kind: 'note', text: `→ tester-2: ${text.slice(0, 90)}…` },
    { agentId: 'tester-2', kind: 'note', text: `← architect: ${text}` },
  ]
  const result = activityLog(lines, { agent: 'tester-2', filter: 'handoffs' })
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0]).toMatchObject({
    from: 'architect',
    to: 'tester-2',
    text,
    category: 'handoffs',
  })
  expect(activityLog(lines, { agent: 'architect' }).total).toBe(1)
})

test('retains unmatched incoming events and identifies distinct repeated messages', () => {
  const lines = [
    { agentId: 'b', kind: 'note', text: '← departed: Prior instruction' },
    { agentId: 'b', kind: 'error', text: 'Failed' },
    { agentId: 'b', kind: 'error', text: 'Failed' },
  ]
  const result = activityLog(lines)
  expect(result.entries[0]).toMatchObject({ from: 'departed', to: 'b', text: 'Prior instruction' })
  expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(3)
  expect(activityLog(lines, { query: 'failed', filter: 'errors', limit: 1 })).toMatchObject({
    total: 2,
    omitted: 1,
  })
  expect(activityLog(lines, { query: 'absent' }).entries).toEqual([])
})
