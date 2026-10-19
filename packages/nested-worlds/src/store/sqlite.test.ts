import { describe, expect, it } from 'bun:test'
import type { LabSnapshot, RunConfig, WorldEvent } from '../contracts.ts'
import { initialUpper } from '../upper/interface.ts'
import { generateWorld } from '../world/generate.ts'
import { openStore } from './sqlite.ts'

const config: RunConfig = {
  seed: 7,
  condition: 'A',
  ticks: 10,
  agents: 2,
  decider: 'fake',
  ablations: { memory: true, nestedSims: false },
  budget: {
    maxCalls: 100,
    maxPromptTokens: 1e6,
    maxCompletionTokens: 1e6,
    maxCostUsd: 1,
    maxConcurrent: 4,
    maxSimDepth: 0,
    maxSims: 0,
    maxAgents: 8,
  },
  checkpointEvery: 5,
  designedExit: true,
}

const ev = (
  tick: number,
  seq: number,
  type: WorldEvent['type'],
  agentId: string | null,
  path = '',
): WorldEvent => ({
  tick,
  seq,
  path,
  type,
  agentId,
  payload: { n: tick * 10 + seq },
})

describe('openStore', () => {
  it('should_create_a_run_and_track_its_status', () => {
    const s = openStore(':memory:')
    const id = s.createRun(config)
    expect(s.run(id)).toEqual({ config, status: 'running' })
    s.setStatus(id, 'paused')
    expect(s.run(id)?.status).toBe('paused')
    expect(s.run('nope')).toBeNull()
  })

  it('should_return_events_in_order_and_filter_them', () => {
    const s = openStore(':memory:')
    const id = s.createRun(config)
    const other = s.createRun(config)
    s.appendEvents(id, [ev(0, 0, 'moved', 'ada'), ev(0, 1, 'said', 'bo'), ev(1, 0, 'moved', 'bo')])
    s.appendEvents(id, [ev(2, 0, 'upper_unlocked', 'ada', 'upper')])
    s.appendEvents(other, [ev(0, 0, 'moved', 'ada')])
    expect(s.events(id)).toHaveLength(4)
    expect(s.events(id)[1]).toEqual(ev(0, 1, 'said', 'bo'))
    expect(s.events(id, { type: 'moved' })).toHaveLength(2)
    expect(s.events(id, { agentId: 'bo' })).toHaveLength(2)
    expect(s.events(id, { path: 'upper' })).toHaveLength(1)
    expect(s.events(id, { fromTick: 1, toTick: 1 })).toEqual([ev(1, 0, 'moved', 'bo')])
  })

  it('should_delete_a_run_s_events_from_a_tick_on_and_leave_other_runs_alone', () => {
    const s = openStore(':memory:')
    const id = s.createRun(config)
    const other = s.createRun(config)
    s.appendEvents(id, [ev(0, 0, 'moved', 'ada'), ev(1, 0, 'moved', 'bo'), ev(2, 0, 'said', 'bo')])
    s.appendEvents(other, [ev(1, 0, 'moved', 'ada')])
    s.deleteEventsFrom(id, 1)
    expect(s.events(id)).toEqual([ev(0, 0, 'moved', 'ada')])
    expect(s.events(other)).toHaveLength(1)
  })

  it('should_keep_the_latest_checkpoint', () => {
    const s = openStore(':memory:')
    const id = s.createRun(config)
    expect(s.latestCheckpoint(id)).toBeNull()
    const base = generateWorld(7, 2)
    const snap = (tick: number): LabSnapshot => ({
      upper: { ...initialUpper(base.rules), tick },
      base: { ...base, tick },
      budgetUsage: { calls: tick, promptTokens: 0, completionTokens: 0, costUsd: 0 },
    })
    s.saveCheckpoint(id, 5, snap(5))
    s.saveCheckpoint(id, 10, snap(10))
    expect(s.latestCheckpoint(id)).toEqual({ tick: 10, snapshot: snap(10) })
  })

  it('should_record_and_find_exchanges', () => {
    const s = openStore(':memory:')
    const r = {
      runId: 'r1',
      agentId: 'ada',
      tick: 3,
      path: '',
      request: { messages: ["it's 'quoted'"] },
      response: '{"type":"wait"}',
      usage: { promptTokens: 10, completionTokens: 2, costUsd: 0.001 },
    }
    s.recordExchange(r)
    expect(s.findExchange('r1', 'ada', 3, '')).toEqual(r)
    expect(s.findExchange('r1', 'ada', 4, '')).toBeNull()
  })

  it('should_persist_across_reopen', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/nw-store-${crypto.randomUUID()}.sqlite`
    const id = openStore(path).createRun(config)
    expect(openStore(path).run(id)?.config).toEqual(config)
  })
})
