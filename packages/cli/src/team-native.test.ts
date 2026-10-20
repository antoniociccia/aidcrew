import { expect, test } from 'bun:test'
import { PluginRegistry } from '@aidcrew/core'
import type { Host } from './host.ts'
import { createTeamHost } from './team.ts'

async function exercise(keepsOwnHistory: boolean) {
  let created = 0
  const registry = new PluginRegistry()
  registry.register({
    name: 'state-test',
    providers: [
      {
        id: 'state-test',
        keepsOwnHistory,
        needsKey: false,
        create: () => {
          created++
          return {
            id: 'state-test',
            async *send() {
              yield {
                type: 'done' as const,
                stopReason: 'end_turn' as const,
                usage: { inputTokens: 0, outputTokens: 0 },
              }
            },
          }
        },
      },
    ],
  })
  const host: Host = {
    registry,
    failures: [],
    refused: [],
    warnings: [],
    servers: [],
    serverFailures: [],
  }
  const team = createTeamHost({
    cwd: process.cwd(),
    host,
    credentials: { for: () => ({ source: 'same', apiKey: '' }), admit: () => true, missing: [] },
    tools: [],
    limits: { maxHops: 3 },
    isolate: false,
    onEvent: () => {},
    defaultProvider: 'state-test',
    providerOptions: () => ({}),
  })
  for (const id of ['first', 'second'])
    await team.spawn({ id, description: id, systemPrompt: id, task: 'same-task' })
  await team.tell('first', 'One')
  await team.idle()
  await team.tell('second', 'Two')
  await team.idle()
  await team.tell('first', 'Three')
  await team.idle()
  const initial = created
  expect(team.forget('first')).toBe(true)
  await team.tell('first', 'After forgetting')
  await team.idle()
  const afterForget = created
  expect(team.setModel('first', { model: 'new-model' })).toBe(true)
  await team.tell('first', 'After changing model')
  await team.idle()
  const afterModel = created
  await team.kill('first')
  await team.spawn({ id: 'first', description: 'first', systemPrompt: 'first', task: 'same-task' })
  await team.tell('first', 'Fresh session')
  await team.idle()
  await team.shutdown()
  return { initial, afterForget, afterModel, final: created }
}

test('agents with owned history never share a provider instance even in the same worktree', async () => {
  expect(await exercise(true)).toEqual({ initial: 2, afterForget: 3, afterModel: 4, final: 5 })
})

test('stateless API clients remain reusable across agents', async () => {
  expect(await exercise(false)).toEqual({ initial: 1, afterForget: 1, afterModel: 1, final: 1 })
})
