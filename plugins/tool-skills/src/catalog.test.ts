import { expect, test } from 'bun:test'
import { createSkillsPlugin } from './plugin.ts'

const context = { cwd: '/tmp', agentId: 'coder', signal: new AbortController().signal }
test('ships a usable skill without project files and exposes only its index in instructions', async () => {
  const plugin = createSkillsPlugin([])
  const tool = plugin.tools?.[0]
  if (!tool) throw new Error('Bundled skill tool is missing')
  const result = await tool.execute({ name: 'decision-lab' }, context)
  expect(result.isError).toBeFalsy()
  expect(result.content).toContain('# Decision Lab')
  const index = await plugin.hooks?.instructions?.({
    ...context,
    tools: ['skill'],
    model: 'test',
    turn: 0,
    lastUsage: { inputTokens: 0, outputTokens: 0 },
  })
  expect(index).toContain('decision-lab')
  expect(index).not.toContain('# Decision Lab')
  expect(
    await plugin.hooks?.instructions?.({
      ...context,
      tools: [],
      model: 'test',
      turn: 0,
      lastUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  ).toBeUndefined()
})
