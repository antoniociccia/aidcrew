import { describe, expect, it } from 'bun:test'
import { ALL_ACTIONS } from '../actions.ts'
import type { Decider, DecisionInput } from '../contracts.ts'
import { openStore } from '../store/sqlite.ts'
import { generateWorld } from '../world/generate.ts'
import { observe } from '../world/observe.ts'
import { FakeDecider } from './fake.ts'
import { buildMessages } from './prompt.ts'
import { RecordingDecider } from './recording.ts'
import { ReplayDecider } from './replay.ts'

const input = (tick = 0, agentId = 'ada'): DecisionInput => ({
  runId: 'r1',
  agentId,
  tick,
  path: '',
  condition: 'A',
  observation: observe(generateWorld(1, 2), agentId, [], null),
  memory: { episodes: [], notes: [], board: [], strategy: '' },
  allowedActions: ALL_ACTIONS,
})

describe('FakeDecider', () => {
  it('should_answer_its_script_as_model_text', async () => {
    const d = new FakeDecider((i) => ({ type: 'move', dir: i.tick % 2 === 0 ? 'N' : 'S' }))
    const out = await d.decide(input(1))
    expect(out.action).toEqual({ type: 'move', dir: 'S' })
    expect(JSON.parse(out.raw).action).toEqual({ type: 'move', dir: 'S' })
    const prompt = buildMessages(input(1)).map((m) => m.content).join('\n')
    expect(out.usage).toEqual({ promptTokens: Math.ceil(prompt.length / 4), completionTokens: 20, costUsd: 0 })
  })
})

describe('RecordingDecider and ReplayDecider', () => {
  it('should_record_each_exchange_and_replay_it_without_the_inner_decider', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-TEST-SECRET'
    const store = openStore(':memory:')
    const inner = new FakeDecider(() => ({ type: 'say', text: 'hello' }))
    const rec = new RecordingDecider(inner, store, 'run-a')
    const live = await rec.decide(input(3))
    const saved = store.findExchange('run-a', 'ada', 3, '')
    expect(saved?.response).toBe(live.raw)
    expect(saved?.request).toEqual({ messages: buildMessages(input(3)), model: 'fake', params: {} })
    expect(JSON.stringify(saved)).not.toContain('sk-or-TEST-SECRET')

    let called = 0
    const forbidden: Decider = {
      name: 'never',
      decide: async () => {
        called++
        throw new Error('replay must not call a decider')
      },
    }
    void forbidden
    const replay = new ReplayDecider(store, 'run-a')
    const again = await replay.decide(input(3))
    expect(again.action).toEqual(live.action)
    expect(again.raw).toBe(live.raw)
    expect(called).toBe(0)
  })

  it('should_throw_when_a_replayed_exchange_is_missing', async () => {
    const replay = new ReplayDecider(openStore(':memory:'), 'nope')
    await expect(replay.decide(input(0))).rejects.toThrow(/no recorded exchange/)
  })
})
