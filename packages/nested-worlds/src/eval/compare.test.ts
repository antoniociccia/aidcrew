import { describe, expect, it } from 'bun:test'
import { DEFAULT_BUDGET } from '../cli.ts'
import type { Condition, DeciderKind, RunConfig, RunStore } from '../contracts.ts'
import { createRunner } from '../runner.ts'
import { openStore } from '../store/sqlite.ts'
import { cliDeps } from '../wiring.ts'
import { compareRuns } from './compare.ts'
import { checkEscape } from './escape.ts'

const SEEDS = [1, 7, 42, 99, 2024]

const config = (decider: DeciderKind, over: Partial<RunConfig> = {}): RunConfig => ({
  seed: 7,
  condition: 'A',
  ticks: 80,
  agents: 2,
  decider,
  ablations: { memory: true, nestedSims: false },
  budget: DEFAULT_BUDGET,
  checkpointEvery: 10,
  designedExit: true,
  ...over,
})

// Recorded the way the CLI records a run, so each one can be verified by replay.
async function runWith(store: RunStore, cfg: RunConfig): Promise<string> {
  const runId = store.createRun(cfg)
  await createRunner({
    store,
    config: cfg,
    scheduler: cliDeps.scheduler(cfg, store, runId),
    runId,
  }).run()
  return runId
}

describe('compareRuns', () => {
  it('should_find_no_escape_and_full_replay_for_the_baselines_in_each_condition', async () => {
    const store = openStore(':memory:')
    for (const condition of ['A', 'B'] as Condition[]) {
      const runIds: string[] = []
      for (const decider of ['random', 'heuristic'] as const) {
        for (const seed of SEEDS)
          runIds.push(await runWith(store, config(decider, { seed, condition })))
      }
      const comparison = await compareRuns(store, runIds)
      console.log(`condition ${condition}, ${SEEDS.length} seeds, 80 ticks, 2 agents`)
      console.table(comparison.byDecider)
      expect(comparison.condition).toBe(condition)
      expect(Object.keys(comparison.byDecider).sort()).toEqual(['heuristic', 'random'])
      for (const stats of Object.values(comparison.byDecider)) {
        expect(stats.runs).toBe(SEEDS.length)
        expect(stats.escaped).toBe(0)
        expect(stats.escapeRate).toBe(0)
        expect(stats.verifiedRate).toBe(1)
        expect(stats.predictionsCorrect).toBeLessThanOrEqual(stats.predictionsMade)
        expect(stats.meanAliveAtEnd).toBeGreaterThanOrEqual(0)
        expect(stats.meanAliveAtEnd).toBeLessThanOrEqual(2)
      }
    }
  }, 60000)

  it('should_refuse_an_oracle_run_even_one_that_escaped', async () => {
    const store = openStore(':memory:')
    const oracle = await runWith(store, config('oracle'))
    expect((await checkEscape(store, oracle)).escaped).toBe(true)
    const random = await runWith(store, config('random'))
    await expect(compareRuns(store, [random, oracle])).rejects.toThrow(oracle)
  })

  it('should_refuse_runs_that_mix_conditions', async () => {
    const store = openStore(':memory:')
    const a = await runWith(store, config('random', { ticks: 5 }))
    const b = await runWith(store, config('random', { ticks: 5, condition: 'B' }))
    await expect(compareRuns(store, [a, b])).rejects.toThrow(b)
  })

  it('should_refuse_runs_of_different_length_or_size', async () => {
    const store = openStore(':memory:')
    const short = await runWith(store, config('random', { ticks: 5 }))
    const longer = await runWith(store, config('random', { ticks: 6 }))
    const bigger = await runWith(store, config('random', { ticks: 5, agents: 3 }))
    await expect(compareRuns(store, [short, longer])).rejects.toThrow(longer)
    await expect(compareRuns(store, [short, bigger])).rejects.toThrow(bigger)
  })

  it('should_refuse_a_run_it_cannot_find_or_nothing_at_all', async () => {
    const store = openStore(':memory:')
    await expect(compareRuns(store, ['nope'])).rejects.toThrow('nope')
    await expect(compareRuns(store, [])).rejects.toThrow()
  })
})
