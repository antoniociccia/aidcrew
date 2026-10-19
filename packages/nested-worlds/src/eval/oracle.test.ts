import { describe, expect, it } from 'bun:test'
import type { RunConfig } from '../contracts.ts'
import { createScheduler } from '../llm/scheduler.ts'
import { createRunner } from '../runner.ts'
import { openStore } from '../store/sqlite.ts'
import { generateWorld } from '../world/generate.ts'
import { oracleDecider } from './oracle.ts'

const config: RunConfig = {
  seed: 7,
  condition: 'A',
  ticks: 80,
  agents: 2,
  decider: 'oracle',
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
}

describe('oracleDecider', () => {
  it('should_walk_the_slab_sequence_and_predict_its_own_write_on_seed_7', async () => {
    const rules = generateWorld(7, 2).rules
    const decider = oracleDecider(rules)
    expect(decider.name).toBe('oracle')
    expect(decider.oracle).toBe(true)

    const store = openStore(':memory:')
    const runner = createRunner({
      store,
      config,
      scheduler: createScheduler(decider, config.budget),
    })
    expect(await runner.run()).toBe('finished')

    const events = store.events(runner.runId)
    const unlock = events.find((e) => e.type === 'upper_unlocked')
    expect(unlock).toBeDefined()
    const writer = unlock?.agentId as string

    const readOk = events.filter(
      (e) =>
        e.type === 'interface_response' &&
        e.agentId === writer &&
        (e.payload as { op?: string }).op === 'read' &&
        (e.payload as { ok?: boolean }).ok === true &&
        e.tick > (unlock?.tick ?? 0),
    )
    expect(readOk.length).toBeGreaterThan(0)

    const write = events.find((e) => e.type === 'upper_write' && e.agentId === writer)
    expect(write).toBeDefined()

    const ownPredictions = events.filter(
      (e) => e.type === 'prediction' && e.agentId === writer && e.tick >= (write?.tick ?? 0),
    )
    expect(ownPredictions.length).toBeGreaterThan(0)
    const ids = new Set(ownPredictions.map((e) => (e.payload as { id: string }).id))
    const resolved = events.filter(
      (e) =>
        e.type === 'prediction_resolved' &&
        e.agentId === writer &&
        (e.payload as { correct?: boolean }).correct === true &&
        ids.has((e.payload as { predictionId: string }).predictionId),
    )
    expect(resolved.length).toBeGreaterThan(0)

    // The claim must hold only because of the write: a spawn at a tick the new
    // harvest period reaches and the old one does not.
    const { before, after } = (write as (typeof events)[number]).payload as {
      before: number
      after: number
    }
    const counterfactual = resolved.some((r) => {
      const id = (r.payload as { predictionId: string }).predictionId
      const made = ownPredictions.find((p) => (p.payload as { id: string }).id === id)
      if (!made) return false
      const claim = (made.payload as { claim: Record<string, unknown> }).claim
      const at = claim.atTick as number
      return (
        claim.kind === 'event_at' &&
        claim.eventType === 'item_spawned' &&
        claim.occurs === true &&
        at % after === 0 &&
        at % before !== 0
      )
    })
    expect(counterfactual).toBe(true)

    const slabUsers = new Set(
      events.filter((e) => e.type === 'interface_response').map((e) => e.agentId),
    )
    expect([...slabUsers]).toEqual([writer])

    const unparsed = events.filter(
      (e) => e.type === 'action_rejected' && (e.payload as { action: unknown }).action === null,
    )
    expect(unparsed).toHaveLength(0)
  })
})
