import { describe, expect, it } from 'bun:test'
import { ALL_ACTIONS, parseAction } from '../actions.ts'
import type { DecisionInput } from '../contracts.ts'
import { generateWorld } from '../world/generate.ts'
import { observe } from '../world/observe.ts'

const input = (tick = 0, agentId = 'ada', over: Partial<DecisionInput> = {}): DecisionInput => ({
  runId: 'r1',
  agentId,
  tick,
  path: '',
  condition: 'A',
  observation: observe(generateWorld(1, 2), agentId, [], null),
  memory: { episodes: [], notes: [], board: [], strategy: '' },
  allowedActions: ALL_ACTIONS,
  ...over,
})

describe('baselines', () => {
  it('randomDecider is deterministic per seed and always schema-valid', async () => {
    const { randomDecider } = await import('./baselines.ts')
    const a = randomDecider(42)
    const b = randomDecider(42)
    expect(a.name).toBe('random')
    expect(a.oracle).toBeUndefined()
    const i = input(3)
    const oa = await a.decide(i)
    const ob = await b.decide(i)
    expect(oa.action).toEqual(ob.action)
    expect(parseAction(oa.action, ALL_ACTIONS).ok).toBe(true)
  })

  it('heuristicDecider eats held food when energy is low and never touches the slab', async () => {
    const { heuristicDecider } = await import('./baselines.ts')
    const h1 = heuristicDecider(7)
    const h2 = heuristicDecider(7)
    expect(h1.name).toBe('heuristic')
    const low = input(0)
    low.observation.self.energy = 10
    low.observation.self.inventory = [{ id: 'food-1', kind: 'food' }]
    const eat = await h1.decide(low)
    expect(eat.action).toEqual({ type: 'use', itemId: 'food-1' })
    const again = await h2.decide(low)
    expect(again.action).toEqual(eat.action)
    for (let t = 0; t < 30; t++) {
      const out = await h1.decide(input(t))
      expect(out.action).not.toMatchObject({ type: 'interface' })
      expect(parseAction(out.action, ALL_ACTIONS).ok).toBe(true)
    }
  })
})
