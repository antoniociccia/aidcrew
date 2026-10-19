import { describe, expect, it } from 'bun:test'
import { ALL_ACTIONS } from '../actions.ts'
import type { DecisionInput, RunConfig } from '../contracts.ts'
import { FakeDecider } from '../llm/fake.ts'
import { buildMessages } from '../llm/prompt.ts'
import { createScheduler } from '../llm/scheduler.ts'
import { createRunner } from '../runner.ts'
import { openStore } from '../store/sqlite.ts'
import { combination } from '../upper/interface.ts'
import { generateWorld } from '../world/generate.ts'
import { observe } from '../world/observe.ts'
import { MAX_ENERGY } from '../world/step.ts'

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  seed: 7,
  condition: 'A',
  ticks: 12,
  agents: 2,
  decider: 'fake',
  ablations: { memory: true, nestedSims: false },
  budget: {
    maxCalls: 1000,
    maxPromptTokens: 1e9,
    maxCompletionTokens: 1e9,
    maxCostUsd: 100,
    maxConcurrent: 4,
    maxSimDepth: 0,
    maxSims: 0,
    maxAgents: 8,
  },
  checkpointEvery: 5,
  designedExit: true,
  ...over,
})

function inputFor(
  seed: number,
  agentId: string,
  condition: 'A' | 'B',
  tick = 4,
  agents = 2,
): { input: DecisionInput; rulesCombo: number[] } {
  const world = generateWorld(seed, agents)
  const observation = observe(world, agentId, [], null)
  const input: DecisionInput = {
    runId: 'r1',
    agentId,
    tick,
    path: '',
    condition,
    observation,
    memory: { episodes: [], notes: [], board: [], strategy: '' },
    allowedActions: ALL_ACTIONS,
  }
  return { input, rulesCombo: combination(world.rules) }
}

describe('invariants', () => {
  it('should_replay_the_same_event_log_from_the_same_seed_and_script', async () => {
    const script = (i: DecisionInput) => ({ type: 'move', dir: i.tick % 2 === 0 ? 'E' : 'W' })
    const runOnce = async () => {
      const store = openStore(':memory:')
      const cfg = config()
      const runner = createRunner({
        store,
        config: cfg,
        scheduler: createScheduler(new FakeDecider(script), cfg.budget),
      })
      await runner.run()
      return store.events(runner.runId).map((e) => ({
        tick: e.tick,
        seq: e.seq,
        type: e.type,
        payload: e.payload,
      }))
    }
    const first = await runOnce()
    const second = await runOnce()
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  it('should_order_events_by_non_decreasing_tick_and_increasing_seq', async () => {
    const store = openStore(':memory:')
    const cfg = config({ ticks: 20 })
    const runner = createRunner({
      store,
      config: cfg,
      scheduler: createScheduler(new FakeDecider(() => ({ type: 'wait' })), cfg.budget),
    })
    await runner.run()
    const events = store.events(runner.runId)
    expect(events.length).toBeGreaterThan(0)
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1] as (typeof events)[number]
      const cur = events[i] as (typeof events)[number]
      expect(cur.tick).toBeGreaterThanOrEqual(prev.tick)
      if (cur.tick === prev.tick) expect(cur.seq).toBeGreaterThan(prev.seq)
    }
  })

  it('should_keep_hidden_rules_and_the_combination_out_of_observations_and_prompts', () => {
    const hiddenKeys = ['regrowthperiod', 'glitch', 'fertile', 'resonance', 'daylength']
    for (const seed of [7, 1, 42, 99, 2024]) {
      const world = generateWorld(seed, 2)
      const combos = [
        combination(world.rules).join(','),
        JSON.stringify(combination(world.rules)),
        combination(world.rules).join(' '),
      ]
      for (const agent of world.agents) {
        const text = JSON.stringify(observe(world, agent.id, [], null)).toLowerCase()
        for (const key of hiddenKeys) expect(text).not.toContain(key)
        for (const combo of combos) expect(text).not.toContain(combo)
        for (const condition of ['A', 'B'] as const) {
          const { input } = inputFor(seed, agent.id, condition)
          const prompt = buildMessages(input)
            .map((m) => m.content)
            .join('\n')
          const lower = prompt.toLowerCase()
          for (const key of hiddenKeys) expect(lower).not.toContain(key)
          for (const combo of combos) expect(lower).not.toContain(combo)
        }
      }
    }
  })

  it('should_never_hint_at_escape_in_condition_a', () => {
    const banned = ['simulat', 'escape', 'exit', 'fuga', 'uscita']
    for (const seed of [7, 1, 42, 99, 2024]) {
      const world = generateWorld(seed, 3)
      for (const agent of world.agents) {
        const { input } = inputFor(seed, agent.id, 'A', 4, 3)
        const lower = buildMessages(input)
          .map((m) => m.content)
          .join('\n')
          .toLowerCase()
        for (const word of banned) expect(lower).not.toContain(word)
      }
    }
  })

  it('should_cap_energy_at_its_max', async () => {
    const store = openStore(':memory:')
    const cfg = config({ ticks: 80, agents: 2 })
    const runner = createRunner({
      store,
      config: cfg,
      scheduler: createScheduler(
        new FakeDecider((i: DecisionInput) => {
          const held = i.observation.self.inventory.find((item) => item.kind === 'food')
          if (held && i.observation.self.energy < 90) return { type: 'use', itemId: held.id }
          const here = i.observation.items.find((item) => item.kind === 'food')
          if (here) return { type: 'pick', itemId: here.id }
          return { type: 'wait' }
        }),
        cfg.budget,
      ),
    })
    await runner.run()
    for (const agent of runner.host.base.agents) {
      expect(agent.energy).toBeLessThanOrEqual(MAX_ENERGY)
    }
    for (const e of store.events(runner.runId)) {
      const after = (e.payload as { after?: unknown }).after
      if (typeof after === 'number') expect(after).toBeLessThanOrEqual(MAX_ENERGY)
    }
  })

  it('should_let_dead_agents_do_nothing_further', async () => {
    const store = openStore(':memory:')
    const cfg = config({ ticks: 200, agents: 1 })
    const runner = createRunner({
      store,
      config: cfg,
      scheduler: createScheduler(new FakeDecider(() => ({ type: 'wait' })), cfg.budget),
    })
    await runner.run()
    const events = store.events(runner.runId)
    const deaths = events.filter((e) => e.type === 'agent_died')
    expect(deaths.length).toBe(1)
    const death = deaths[0] as (typeof events)[number]
    const victim = death.agentId
    expect(victim).not.toBeNull()
    for (const e of events) {
      if (e.tick > death.tick && (e.type === 'action' || e.type === 'decision')) {
        expect(e.agentId).not.toBe(victim)
      }
    }
  })

  it('should_never_spend_more_calls_than_the_budget_allows', async () => {
    const decider = new FakeDecider(() => ({ type: 'wait' }))
    const scheduler = createScheduler(decider, {
      maxCalls: 3,
      maxPromptTokens: 1e9,
      maxCompletionTokens: 1e9,
      maxCostUsd: 100,
      maxConcurrent: 1,
      maxSimDepth: 0,
      maxSims: 0,
      maxAgents: 8,
    })
    const world = generateWorld(7, 2)
    const inputs: DecisionInput[] = ['ada', 'bo', 'ada', 'bo'].map((agentId, n) => ({
      runId: 'r1',
      agentId,
      tick: n,
      path: '',
      condition: 'A',
      observation: observe(world, world.agents[0]?.id ?? 'ada', [], null),
      memory: { episodes: [], notes: [], board: [], strategy: '' },
      allowedActions: ALL_ACTIONS,
    }))
    const result = await scheduler.decideAll(inputs)
    expect(result.exhausted).toBe(true)
    expect(result.outputs.size).toBeLessThanOrEqual(3)
    expect(scheduler.usage().calls).toBeLessThanOrEqual(3)
  })
})
