import { describe, expect, it } from 'bun:test'
import type {
  AgentId,
  BudgetUsage,
  DecisionInput,
  DecisionOutput,
  RunConfig,
  Scheduler,
} from './contracts.ts'
import { createRunner, resumeRunner } from './runner.ts'
import { openStore } from './store/sqlite.ts'

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

/** Decides by a script; stops answering after `limit` calls, like a spent budget. */
function scripted(
  decide: (i: DecisionInput) => unknown,
  limit = Number.POSITIVE_INFINITY,
): Scheduler & { seen: DecisionInput[] } {
  const seen: DecisionInput[] = []
  let calls = 0
  return {
    seen,
    async decideAll(inputs) {
      const outputs = new Map<AgentId, DecisionOutput>()
      for (const i of inputs) {
        if (calls >= limit) return { outputs, exhausted: true }
        calls++
        seen.push(i)
        const action = decide(i)
        outputs.set(i.agentId, {
          raw: JSON.stringify(action),
          action,
          rationale: `because ${i.tick}`,
        })
      }
      return { outputs, exhausted: false }
    },
    usage: (): BudgetUsage => ({ calls, promptTokens: 0, completionTokens: 0, costUsd: 0 }),
  }
}

const walker = (i: DecisionInput) => ({ type: 'move', dir: i.tick % 2 === 0 ? 'E' : 'W' })

describe('runner', () => {
  it('should_run_to_the_configured_tick_and_checkpoint_on_schedule', async () => {
    const store = openStore(':memory:')
    const r = createRunner({ store, config: config(), scheduler: scripted(walker) })
    expect(await r.run()).toBe('finished')
    expect(store.run(r.runId)?.status).toBe('finished')
    expect(r.host.base.tick).toBe(12)
    const decisions = store.events(r.runId, { type: 'decision' })
    expect(decisions).toHaveLength(24)
    expect(decisions[0]?.payload).toMatchObject({ decider: 'fake', rationale: 'because 0' })
    expect(store.events(r.runId, { type: 'checkpoint' }).map((e) => e.tick)).toEqual([4, 9, 11])
    expect(store.latestCheckpoint(r.runId)?.tick).toBe(12)
  })

  it('should_hand_each_agent_its_observation_memory_and_last_result', async () => {
    const store = openStore(':memory:')
    const s = scripted((i) =>
      i.agentId === 'ada' ? { type: 'say', text: `t${i.tick}` } : { type: 'wait' },
    )
    const r = createRunner({ store, config: config({ ticks: 3 }), scheduler: s })
    await r.run()
    const ada1 = s.seen.find((i) => i.agentId === 'ada' && i.tick === 1)
    expect(ada1?.observation.lastResult).toEqual({ ok: true, message: 'You speak.' })
    expect(ada1?.memory.episodes).toContain('t0: you said "t0"')
    expect(ada1?.condition).toBe('A')
    expect(ada1?.allowedActions).toContain('interface')
  })

  it('should_turn_an_invalid_answer_into_a_rejected_wait', async () => {
    const store = openStore(':memory:')
    const s = scripted(() => ({ type: 'teleport' }))
    const r = createRunner({ store, config: config({ ticks: 2 }), scheduler: s })
    await r.run()
    const rejected = store.events(r.runId, { type: 'action_rejected', toTick: 0 })
    expect(rejected).toHaveLength(2)
    expect(store.events(r.runId, { type: 'action', toTick: 0 })[0]?.payload.action).toEqual({
      type: 'wait',
    })
    expect(s.seen.find((i) => i.tick === 1)?.observation.lastResult?.ok).toBe(false)
  })

  it('should_forget_when_memory_is_ablated', async () => {
    const store = openStore(':memory:')
    const s = scripted(() => ({ type: 'say', text: 'x' }))
    const r = createRunner({
      store,
      config: config({ ticks: 3, ablations: { memory: false, nestedSims: false } }),
      scheduler: s,
    })
    await r.run()
    expect(s.seen.every((i) => i.memory.episodes.length === 0)).toBe(true)
  })

  it('should_finish_the_tick_and_stop_when_the_budget_is_spent', async () => {
    const store = openStore(':memory:')
    const r = createRunner({ store, config: config(), scheduler: scripted(walker, 5) })
    expect(await r.run()).toBe('budget_exhausted')
    expect(r.host.base.tick).toBe(3)
    expect(store.run(r.runId)?.status).toBe('budget_exhausted')
    expect(store.events(r.runId, { type: 'budget_exhausted' })).toHaveLength(1)
    expect(store.events(r.runId, { type: 'decision', fromTick: 2 })).toHaveLength(1)
  })

  it('should_resume_from_a_pause_into_the_same_world_as_an_unbroken_run', async () => {
    const straight = openStore(':memory:')
    const a = createRunner({ store: straight, config: config(), scheduler: scripted(walker) })
    await a.run()

    const store = openStore(':memory:')
    const b = createRunner({ store, config: config(), scheduler: scripted(walker) })
    await b.run(7)
    b.pause()
    expect(store.run(b.runId)?.status).toBe('paused')
    const c = resumeRunner(store, b.runId, scripted(walker))
    expect(c.host.base.tick).toBe(7)
    expect(await c.run()).toBe('finished')
    expect(c.host.base).toEqual(a.host.base)
    const strip = (es: { tick: number; type: string }[]) =>
      es
        .filter((e) => e.type !== 'checkpoint' && e.type !== 'run_status')
        .map((e) => JSON.stringify(e))
    expect(strip(store.events(b.runId))).toEqual(strip(straight.events(a.runId)))
  })

  it('should_stop_when_every_agent_is_dead', async () => {
    const store = openStore(':memory:')
    const r = createRunner({
      store,
      config: config({ ticks: 200, agents: 1 }),
      scheduler: scripted(() => ({ type: 'wait' })),
    })
    expect(await r.run()).toBe('finished')
    expect(r.host.base.agents[0]?.alive).toBe(false)
    expect(r.host.base.tick).toBe(60)
  })
})
