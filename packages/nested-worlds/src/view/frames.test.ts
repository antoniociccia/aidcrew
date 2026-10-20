import { describe, expect, it } from 'bun:test'
import { DEFAULT_BUDGET } from '../cli.ts'
import type { RunConfig, RunStore } from '../contracts.ts'
import { createRunner } from '../runner.ts'
import { openStore } from '../store/sqlite.ts'
import { cliDeps } from '../wiring.ts'
import { withinReach } from '../world/step.ts'
import { createFrameCursor, framesOf } from './frames.ts'

const config: RunConfig = {
  seed: 7,
  condition: 'A',
  ticks: 80,
  agents: 2,
  decider: 'oracle',
  ablations: { memory: true, nestedSims: false },
  budget: DEFAULT_BUDGET,
  checkpointEvery: 10,
  designedExit: true,
}

async function oracleRun(): Promise<{ store: RunStore; runId: string }> {
  const store = openStore(':memory:')
  const runId = store.createRun(config)
  await createRunner({
    store,
    config,
    scheduler: cliDeps.scheduler(config, store, runId),
    runId,
  }).run()
  return { store, runId }
}

describe('framesOf', () => {
  it('should_show_ada_at_the_slab_when_it_unlocks_and_harvest_at_3_after_her_write', async () => {
    const { store, runId } = await oracleRun()
    const frames = framesOf(store, runId)
    expect(frames.map((f) => f.tick)).toEqual([...Array(80).keys()])

    const unlock = store.events(runId, { type: 'upper_unlocked' })[0]
    const atUnlock = frames[unlock?.tick ?? -1]
    const ada = atUnlock?.agents.find((a) => a.id === 'ada')
    const slab = atUnlock?.items.find((i) => i.kind === 'slab')
    expect(ada && slab && withinReach(ada.pos, slab.pos)).toBe(true)
    expect(atUnlock?.upper.unlocked).toBe(true)
    expect(atUnlock?.events.some((e) => e.type === 'upper_unlocked')).toBe(true)

    const write = store.events(runId, { type: 'upper_write' })[0]
    expect(frames[(write?.tick ?? 0) - 1]?.upper.registers.harvest).toBe(5)
    expect(frames[write?.tick ?? -1]?.upper.registers.harvest).toBe(3)
  })

  it('should_end_where_the_runner_left_the_world', async () => {
    const { store, runId } = await oracleRun()
    const last = framesOf(store, runId).at(-1)
    const saved = store.latestCheckpoint(runId)?.snapshot.base
    expect(last?.agents.map((a) => [a.id, a.pos, a.energy, a.alive])).toEqual(
      saved?.agents.map((a) => [a.id, a.pos, a.energy, a.alive]) ?? [],
    )
  })

  it('should_cut_a_range_and_carry_each_tick_s_events', async () => {
    const { store, runId } = await oracleRun()
    const frames = framesOf(store, runId, { from: 5, to: 7 })
    expect(frames.map((f) => f.tick)).toEqual([5, 6, 7])
    for (const f of frames) expect(f.events.every((e) => e.tick === f.tick)).toBe(true)
  })
})

describe('createFrameCursor', () => {
  it('should_hand_out_only_the_ticks_written_since_it_last_looked', async () => {
    const { store, runId } = await oracleRun()
    const cursor = createFrameCursor(store, runId)
    expect(cursor.advance()).toHaveLength(80)
    expect(cursor.advance()).toHaveLength(0)
  })
})
