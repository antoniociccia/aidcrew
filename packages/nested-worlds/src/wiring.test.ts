import { describe, expect, it } from 'bun:test'
import { DEFAULT_BUDGET } from './cli.ts'
import type { DeciderKind, RunConfig } from './contracts.ts'
import type { AidcrewProvider } from './llm/aidcrew.ts'
import { createRunner } from './runner.ts'
import { openStore } from './store/sqlite.ts'
import { cliDeps, makeCliDeps } from './wiring.ts'

const config = (decider: DeciderKind, over: Partial<RunConfig> = {}): RunConfig => ({
  seed: 7,
  condition: 'A',
  ticks: 4,
  agents: 2,
  decider,
  ablations: { memory: true, nestedSims: false },
  budget: DEFAULT_BUDGET,
  checkpointEvery: 10,
  designedExit: true,
  ...over,
})

async function runWith(store: ReturnType<typeof openStore>, cfg: RunConfig) {
  const runId = store.createRun(cfg)
  const scheduler = await cliDeps.scheduler(cfg, store, runId)
  await createRunner({ store, config: cfg, scheduler, runId }).run()
  return runId
}

const actions = (store: ReturnType<typeof openStore>, runId: string) =>
  store.events(runId, { type: 'action' }).map((e) => JSON.stringify([e.tick, e.agentId, e.payload]))

describe('cliDeps', () => {
  it('should_record_every_exchange_a_live_decider_makes', async () => {
    const store = openStore(':memory:')
    const runId = await runWith(store, config('fake'))
    expect(store.run(runId)?.status).toBe('finished')
    expect(store.findExchange(runId, 'ada', 3, '')?.response).toContain('"action"')
  })

  it('should_replay_a_recorded_run_into_the_same_actions', async () => {
    const store = openStore(':memory:')
    const original = await runWith(store, config('fake'))
    const replay = await runWith(store, config('replay', { replayOf: original }))
    expect(actions(store, replay)).toEqual(actions(store, original))
    expect(store.findExchange(replay, 'ada', 0, '')).toBeNull()
  })

  it('should_run_the_random_and_heuristic_baselines', async () => {
    for (const decider of ['random', 'heuristic'] as const) {
      const store = openStore(':memory:')
      const runId = await runWith(store, config(decider))
      expect(store.run(runId)?.status).toBe('finished')
      const decisions = store.events(runId, { type: 'decision' })
      expect(decisions.length).toBeGreaterThan(0)
      // The world may refuse a move into water; the schema must refuse nothing.
      const unparsed = store
        .events(runId, { type: 'action_rejected' })
        .filter((e) => e.payload.action === null)
      expect(unparsed).toHaveLength(0)
    }
  })

  it('should_run_the_oracle_on_the_rules_of_the_seeded_world', async () => {
    const store = openStore(':memory:')
    const runId = await runWith(store, config('oracle', { ticks: 30 }))
    expect(store.events(runId, { type: 'upper_unlocked' })).toHaveLength(1)
  })

  it('should_report_a_run_as_text_with_its_escape_verdict', async () => {
    const store = openStore(':memory:')
    const runId = await runWith(store, config('fake'))
    const report = await cliDeps.report(store, runId)
    expect(report).toContain('escaped: false')
    expect(report).toContain('verified: true')
  })

  it('should_run_a_live_model_through_its_provider_and_replay_it_without_one', async () => {
    const asked: string[] = []
    const provider: AidcrewProvider = {
      id: 'stub',
      async *send(request) {
        asked.push(request.model)
        yield { type: 'text_delta', text: '{"action":{"type":"wait"},"rationale":"resting"}' }
        yield {
          type: 'done',
          stopReason: 'end',
          usage: { inputTokens: 10, outputTokens: 5, chargedUsd: 0.001 },
        }
      },
    }
    const found: string[] = []
    const deps = makeCliDeps(async (providerId) => {
      found.push(providerId)
      return provider
    })
    const store = openStore(':memory:')
    const cfg = config('aidcrew', {
      provider: 'opencode-go',
      model: 'muse-spark-1.3-contributor',
      ticks: 3,
    })
    const runId = store.createRun(cfg)
    await createRunner({
      store,
      config: cfg,
      scheduler: await deps.scheduler(cfg, store, runId),
      runId,
    }).run()
    expect(found).toEqual(['opencode-go'])
    expect(asked).toHaveLength(6)
    expect(new Set(asked)).toEqual(new Set(['muse-spark-1.3-contributor']))
    const decision = store.events(runId, { type: 'decision' })[0]
    expect(decision?.payload).toMatchObject({ decider: 'aidcrew', rationale: 'resting' })
    expect(await deps.report(store, runId)).toContain('verified: true')
  })

  it('should_refuse_an_aidcrew_run_without_a_provider_or_model', async () => {
    const deps = makeCliDeps(async () => {
      throw new Error('unreachable')
    })
    const store = openStore(':memory:')
    const built = Promise.resolve().then(() => deps.scheduler(config('aidcrew'), store, 'r'))
    await expect(built).rejects.toThrow(/--provider/)
  })

  it('should_refuse_openrouter_until_phase_2', async () => {
    const store = openStore(':memory:')
    const built = Promise.resolve().then(() => cliDeps.scheduler(config('openrouter'), store, 'r'))
    await expect(built).rejects.toThrow(/phase 2/)
  })

  it('should_hold_the_run_to_its_budget', async () => {
    const store = openStore(':memory:')
    const cfg = config('fake', { budget: { ...DEFAULT_BUDGET, maxCalls: 3 } })
    const runId = await runWith(store, cfg)
    expect(store.run(runId)?.status).toBe('budget_exhausted')
    expect(store.events(runId, { type: 'decision' })).toHaveLength(3)
  })
})
