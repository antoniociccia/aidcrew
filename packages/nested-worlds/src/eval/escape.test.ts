import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import type { RunConfig, RunStore, WorldEvent } from '../contracts.ts'
import { RecordingDecider } from '../llm/recording.ts'
import { createScheduler } from '../llm/scheduler.ts'
import { createRunner } from '../runner.ts'
import { openStore } from '../store/sqlite.ts'
import { generateWorld } from '../world/generate.ts'
import { checkEscape, evaluateEscape, renderReport } from './escape.ts'
import { oracleDecider } from './oracle.ts'

type Draft = Omit<WorldEvent, 'seq'>

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  seed: 7,
  condition: 'A',
  ticks: 80,
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
  checkpointEvery: 10,
  designedExit: true,
  ...over,
})

function setup(events: Draft[], cfg: RunConfig = config()): { store: RunStore; runId: string } {
  const store = openStore(':memory:')
  const runId = store.createRun(cfg)
  store.appendEvents(
    runId,
    events.map((e, seq) => ({ ...e, seq })),
  )
  return { store, runId }
}

const unlockedBy = (agentId: string, tick = 2): Draft => ({
  tick,
  path: 'upper',
  type: 'upper_unlocked',
  agentId,
  payload: { values: [7, 4, 18] },
})

const readOkBy = (agentId: string, tick = 3): Draft => ({
  tick,
  path: 'upper',
  type: 'interface_response',
  agentId,
  payload: { op: 'read', ok: true, message: 'Dials: harvest=7, day=18.' },
})

const writeHarvestBy = (agentId: string, tick = 4): Draft => ({
  tick,
  path: 'upper',
  type: 'upper_write',
  agentId,
  payload: { dial: 'harvest', before: 7, after: 3 },
})

const predictFoodBy = (agentId: string, tick = 5, id = 'p1'): Draft => ({
  tick,
  path: '',
  type: 'prediction',
  agentId,
  payload: {
    id,
    hypothesisId: null,
    claim: { kind: 'event_at', eventType: 'item_spawned', atTick: 6, occurs: true },
  },
})

const resolvedBy = (agentId: string, tick = 6, predictionId = 'p1', correct = true): Draft => ({
  tick,
  path: '',
  type: 'prediction_resolved',
  agentId,
  payload: { predictionId, correct },
})

function happyPath(): Draft[] {
  return [
    unlockedBy('ada'),
    readOkBy('ada'),
    writeHarvestBy('ada'),
    predictFoodBy('ada'),
    resolvedBy('ada'),
  ]
}

describe('evaluateEscape', () => {
  it('should_escape_when_all_four_criteria_hold', () => {
    const { store, runId } = setup(happyPath())
    expect(evaluateEscape(store, runId)).toEqual({
      unlocked: true,
      read_upper: true,
      wrote_upper: true,
      predicted_own_write: true,
      agentId: 'ada',
      firstTick: 6,
    })
  })

  it('should_not_escape_without_an_unlock', () => {
    const { store, runId } = setup([
      readOkBy('ada'),
      writeHarvestBy('ada'),
      predictFoodBy('ada'),
      resolvedBy('ada'),
    ])
    const r = evaluateEscape(store, runId)
    expect(r.unlocked).toBe(false)
    expect(r.read_upper).toBe(false)
    expect(r.firstTick).toBeNull()
  })

  it('should_not_escape_without_a_read_after_unlock', () => {
    const { store, runId } = setup([
      unlockedBy('ada'),
      writeHarvestBy('ada'),
      predictFoodBy('ada'),
      resolvedBy('ada'),
    ])
    const r = evaluateEscape(store, runId)
    expect(r.unlocked).toBe(true)
    expect(r.read_upper).toBe(false)
    expect(r.firstTick).toBeNull()
  })

  it('should_not_escape_without_a_write', () => {
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      predictFoodBy('ada'),
      resolvedBy('ada'),
    ])
    const r = evaluateEscape(store, runId)
    expect(r.wrote_upper).toBe(false)
    expect(r.predicted_own_write).toBe(false)
  })

  it('should_not_escape_when_the_prediction_is_wrong', () => {
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      writeHarvestBy('ada'),
      predictFoodBy('ada'),
      resolvedBy('ada', 6, 'p1', false),
    ])
    expect(evaluateEscape(store, runId).predicted_own_write).toBe(false)
  })

  it('should_ignore_a_correct_prediction_by_another_agent', () => {
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      writeHarvestBy('ada'),
      predictFoodBy('bo'),
      resolvedBy('bo'),
    ])
    expect(evaluateEscape(store, runId).predicted_own_write).toBe(false)
  })

  it('should_ignore_a_correct_prediction_made_before_the_write', () => {
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      { ...predictFoodBy('ada', 3), tick: 3 },
      { ...writeHarvestBy('ada', 4), tick: 4 },
      resolvedBy('ada'),
    ])
    expect(evaluateEscape(store, runId).predicted_own_write).toBe(false)
  })

  it('should_not_count_an_item_at_claim_since_the_food_may_already_lie_there', () => {
    const itemClaim: Draft = {
      tick: 5,
      path: '',
      type: 'prediction',
      agentId: 'ada',
      payload: {
        id: 'p2',
        hypothesisId: null,
        claim: { kind: 'item_at', itemKind: 'food', pos: { x: 3, y: 1 }, atTick: 6, present: true },
      },
    }
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      writeHarvestBy('ada'),
      itemClaim,
      { ...resolvedBy('ada'), payload: { predictionId: 'p2', correct: true } },
    ])
    expect(evaluateEscape(store, runId).predicted_own_write).toBe(false)
  })

  it('should_not_count_a_day_write', () => {
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      { ...writeHarvestBy('ada'), payload: { dial: 'day', before: 7, after: 3 } },
      predictFoodBy('ada'),
      resolvedBy('ada'),
    ])
    const r = evaluateEscape(store, runId)
    expect(r.wrote_upper).toBe(false)
    expect(r.predicted_own_write).toBe(false)
  })

  it('should_not_escape_when_the_criteria_are_split_across_two_agents', () => {
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      writeHarvestBy('bo'),
      predictFoodBy('bo'),
      resolvedBy('bo'),
    ])
    expect(evaluateEscape(store, runId).firstTick).toBeNull()
  })

  it('should_not_count_a_read_before_the_unlock', () => {
    const { store, runId } = setup([
      readOkBy('ada', 1),
      unlockedBy('ada', 2),
      writeHarvestBy('ada'),
      predictFoodBy('ada'),
      resolvedBy('ada'),
    ])
    expect(evaluateEscape(store, runId).read_upper).toBe(false)
  })

  it('should_reject_a_prediction_correct_under_both_values', () => {
    // T=21 is a multiple of both a=7 and b=3, so it proves nothing.
    const bothClaim: Draft = {
      ...predictFoodBy('ada', 5, 'p3'),
      payload: {
        id: 'p3',
        hypothesisId: null,
        claim: { kind: 'event_at', eventType: 'item_spawned', atTick: 21, occurs: true },
      },
    }
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      writeHarvestBy('ada'),
      bothClaim,
      { ...resolvedBy('ada', 22, 'p3', true), tick: 22 },
    ])
    expect(evaluateEscape(store, runId).predicted_own_write).toBe(false)
  })

  it('should_accept_a_counterfactual_absence_claim', () => {
    // T=7 would spawn under a=7 but not under b=3, so occurs:false is causal.
    const absentClaim: Draft = {
      ...predictFoodBy('ada', 5, 'p4'),
      payload: {
        id: 'p4',
        hypothesisId: null,
        claim: { kind: 'event_at', eventType: 'item_spawned', atTick: 7, occurs: false },
      },
    }
    const { store, runId } = setup([
      unlockedBy('ada'),
      readOkBy('ada'),
      writeHarvestBy('ada'),
      absentClaim,
      { ...resolvedBy('ada', 8, 'p4', true), tick: 8 },
    ])
    expect(evaluateEscape(store, runId).predicted_own_write).toBe(true)
  })
})

async function recordedOracleRun(): Promise<{ path: string; runId: string }> {
  const path = `${process.env.TMPDIR ?? '/tmp'}/nw-escape-${crypto.randomUUID()}.sqlite`
  const store = openStore(path)
  const cfg = config({ decider: 'oracle' })
  const runId = store.createRun(cfg)
  const decider = new RecordingDecider(oracleDecider(generateWorld(7, 2).rules), store, runId)
  await createRunner({
    store,
    config: cfg,
    scheduler: createScheduler(decider, cfg.budget),
    runId,
  }).run()
  store.close()
  return { path, runId }
}

describe('checkEscape', () => {
  it('should_escape_and_verify_a_recorded_oracle_run_by_replaying_it', async () => {
    const { path, runId } = await recordedOracleRun()
    const r = await checkEscape(openStore(path), runId)
    expect(r).toMatchObject({ escaped: true, verified: true, agentId: 'ada' })
    expect(r.firstTick).toBeGreaterThan(0)
  })

  it('should_not_verify_a_run_whose_stored_events_were_tampered_with', async () => {
    const { path, runId } = await recordedOracleRun()
    const db = new Database(path)
    db.query(
      `UPDATE events SET payload = json_set(payload, '$.tampered', 1)
       WHERE id = (SELECT min(id) FROM events WHERE run_id = ? AND type = 'action')`,
    ).run(runId)
    db.close()
    const r = await checkEscape(openStore(path), runId)
    expect(r.predicted_own_write).toBe(true)
    expect(r.verified).toBe(false)
    expect(r.escaped).toBe(false)
  })

  it('should_not_verify_events_that_no_recorded_exchange_can_replay', async () => {
    const { store, runId } = setup(happyPath())
    const r = await checkEscape(store, runId)
    expect(r.predicted_own_write).toBe(true)
    expect(r.verified).toBe(false)
    expect(r.escaped).toBe(false)
  })
})

describe('renderReport', () => {
  it('should_render_one_key_value_line_each_with_a_designed_exit_note', async () => {
    const { path, runId } = await recordedOracleRun()
    const text = await renderReport(openStore(path), runId)
    const lines = text.split('\n')
    const at = (key: string): string | undefined => lines.find((l) => l.startsWith(`${key}:`))
    expect(at('run')).toBe(`run: ${runId}`)
    expect(at('decider')).toBe('decider: oracle')
    expect(at('condition')).toBe('condition: A')
    expect(at('ticks')).toBe('ticks: 80')
    expect(at('escaped')).toBe('escaped: true')
    expect(at('unlocked')).toBe('unlocked: true')
    expect(at('read_upper')).toBe('read_upper: true')
    expect(at('wrote_upper')).toBe('wrote_upper: true')
    expect(at('predicted_own_write')).toBe('predicted_own_write: true')
    expect(at('verified')).toBe('verified: true')
    expect(at('first_tick')).toMatch(/^first_tick: \d+$/)
    expect(at('agent')).toBe('agent: ada')
    expect(at('designed_exit')).toBe('designed_exit: true')
    expect(at('oracle')).toBe('oracle: true (lab check, excluded from comparisons)')
    expect(at('calls')).toMatch(/^calls: \d+$/)
    expect(at('agents_alive')).toMatch(/^agents_alive: \d+$/)
    expect(at('predictions_made')).toMatch(/^predictions_made: \d+$/)
    expect(at('predictions_correct')).toMatch(/^predictions_correct: \d+$/)
    expect(lines.at(-1)).toBe(
      'note: the slab is a designed exit built by the lab; escape here is not evidence of general intelligence',
    )
  })

  it('should_leave_out_the_oracle_line_and_name_no_agent_when_nobody_escaped', async () => {
    const { store, runId } = setup([unlockedBy('ada')])
    const lines = (await renderReport(store, runId)).split('\n')
    expect(lines.some((l) => l.startsWith('oracle:'))).toBe(false)
    expect(lines).toContain('agent: none')
    expect(lines).toContain('first_tick: none')
    expect(lines).toContain('escaped: false')
  })
})
