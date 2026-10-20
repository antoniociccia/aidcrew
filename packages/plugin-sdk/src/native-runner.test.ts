import { expect, test } from 'bun:test'
import type { LoopEvent, LoopOptions, LoopResult, Provider } from '@aidcrew/core'
import { ProviderResponseError, runAgentLoop } from '@aidcrew/core'
import { withPromptedTools } from './prompted-tools.ts'
import { retrying } from './retrying.ts'

test('provider wrappers preserve native execution and its original receiver', async () => {
  let runs = 0
  const provider: Provider = {
    id: 'native',
    send() {
      throw new Error('Native provider must not use send')
    },
    async *run(options: LoopOptions): AsyncGenerator<LoopEvent, LoopResult> {
      expect(this).toBe(provider)
      runs++
      yield { type: 'turn_start', turn: 1 }
      return {
        messages: options.messages,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        stopReason: 'end_turn',
      }
    },
  }
  for (const wrapped of [
    retrying(provider),
    withPromptedTools(provider),
    retrying(withPromptedTools(provider)),
  ]) {
    const run = runAgentLoop({
      provider: wrapped,
      model: 'native',
      system: 'role',
      tools: [],
      messages: [],
    })
    expect((await run.next()).value).toEqual({ type: 'turn_start', turn: 1 })
    expect((await run.next()).done).toBe(true)
  }
  expect(runs).toBe(3)
})

test('retry wrappers never replay a native execution after side effects', async () => {
  let runs = 0
  const provider: Provider = {
    id: 'native',
    send() {
      throw new Error('send must not run')
    },
    async *run(): AsyncGenerator<LoopEvent, LoopResult> {
      runs++
      yield { type: 'turn_start', turn: 1 }
      throw new ProviderResponseError('Process stopped after editing a file', 'native', true)
    },
  }
  const run = runAgentLoop({
    provider: retrying(provider, 3, 1),
    model: 'native',
    system: '',
    tools: [],
    messages: [],
  })
  await run.next()
  await expect(run.next()).rejects.toThrow('Process stopped after editing a file')
  expect(runs).toBe(1)
})
