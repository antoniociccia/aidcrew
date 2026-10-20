import { expect, test } from 'bun:test'
import { chatMessages, defaultChatAgent } from './quick-chat.ts'

test('uses the saved contact only while present and falls back to the lead', () => {
  const agents = [{ id: 'coder' }, { id: 'architect' }]
  expect(defaultChatAgent(agents, 'coder', 'architect')).toBe('coder')
  expect(defaultChatAgent(agents, 'removed', 'coder')).toBe('architect')
  expect(defaultChatAgent([{ id: 'tester' }], {}, 'removed')).toBe('tester')
  expect(defaultChatAgent([], 'coder', 'coder')).toBe('')
})

test('quick chat shows only the addressed human and agent conversation', () => {
  const lines = [
    { agentId: 'architect', kind: 'ask', text: 'Build it' },
    { agentId: 'coder', kind: 'say', text: 'Other conversation' },
    { agentId: 'architect', kind: 'thinking', text: 'Private reasoning' },
    { agentId: 'architect', kind: 'tool', text: 'read file' },
    { agentId: 'architect', kind: 'note', text: '→ coder: delegate' },
    { agentId: 'architect', kind: 'say', text: 'The plan is ready' },
  ]
  expect(chatMessages(lines, 'architect').map((entry) => entry.text)).toEqual([
    'Build it',
    'The plan is ready',
  ])
  expect(chatMessages(lines, 'missing')).toEqual([])
})
