import { expect, test } from 'bun:test'
import { selectFeed } from './feed.ts'

const lines = [
  { agentId: 'coder', kind: 'ask', text: 'Fix the parser' },
  { agentId: 'coder', kind: 'thinking', text: 'Private reasoning' },
  { agentId: 'reviewer', kind: 'error', text: 'Parser failed' },
  { agentId: 'coder', kind: 'tool', text: 'read src/parser.ts' },
  { agentId: 'coder', kind: 'diff', text: '~ src/parser.ts' },
  { agentId: 'coder', kind: 'diff', text: '- unsafe(input)' },
  { agentId: 'coder', kind: 'diff', text: '+ validate(input)' },
  { agentId: 'coder', kind: 'say', text: 'Fixed [parser].' },
] as const

test('searches literal text and agent names case-insensitively within the selected scope', () => {
  expect(selectFeed(lines, { query: '  PARSER ', agent: 'reviewer' }).groups.flat()).toEqual([
    lines[2],
  ])
  expect(selectFeed(lines, { query: '[parser]' }).groups.flat()).toEqual([lines[7]])
  expect(selectFeed(lines, { query: 'REVIEWER' }).groups.flat()).toEqual([lines[2]])
  expect(selectFeed(lines, { query: '.*' }).groups).toEqual([])
})

test('keeps a matching diff intact and does not join blocks across filtered-out events', () => {
  expect(selectFeed(lines, { query: 'validate' }).groups).toEqual([lines.slice(4, 7)])
  const separated = [lines[4], lines[3], lines[6]]
  expect(selectFeed(separated, { filter: 'changes' }).groups).toEqual([[lines[4]], [lines[6]]])
})

test('filters conversation, tools, changes and errors without exposing hidden reasoning', () => {
  expect(selectFeed(lines, { filter: 'conversation' }).groups.flat()).toEqual([lines[0], lines[7]])
  expect(selectFeed(lines, { filter: 'tools' }).groups.flat()).toEqual([lines[3]])
  expect(selectFeed(lines, { filter: 'errors' }).groups.flat()).toEqual([lines[2]])
  expect(selectFeed(lines, { query: 'Private' }).total).toBe(0)
  expect(selectFeed(lines, { query: 'Private', reasoning: true }).total).toBe(1)
})

test('offers notes and handoffs separately from human and agent replies', () => {
  const notes = [{ agentId: 'coder', kind: 'note', text: 'architect → coder: review the parser' }]
  expect(selectFeed([...lines, ...notes], { filter: 'notes' }).groups.flat()).toEqual(notes)
})

test('limits recent results by complete entries and reports omitted matches', () => {
  const result = selectFeed(lines, { limit: 2 })
  expect(result.groups).toEqual([lines.slice(4, 7), [lines[7]]])
  expect(result.total).toBe(5)
  expect(selectFeed([], {}).groups).toEqual([])
  expect(selectFeed(lines, { limit: 0 }).groups).toEqual([])
})
