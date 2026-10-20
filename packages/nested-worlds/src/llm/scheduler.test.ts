import { describe, expect, it } from 'bun:test'
import type { Budget, Decider, DecisionInput, DecisionOutput } from '../contracts.ts'
import { createScheduler } from './scheduler.ts'

const budget = (over: Partial<Budget> = {}): Budget => ({
  maxCalls: 100,
  maxPromptTokens: 1e6,
  maxCompletionTokens: 1e6,
  maxCostUsd: 10,
  maxConcurrent: 2,
  maxSimDepth: 0,
  maxSims: 0,
  maxAgents: 8,
  ...over,
})

const input = (agentId: string): DecisionInput =>
  ({ runId: 'r', agentId, tick: 0, path: '', condition: 'A' }) as DecisionInput

/** Answers after a delay that makes later agents finish first. */
function slow(): Decider & { inFlight: number; peak: number } {
  const d = {
    name: 'slow',
    inFlight: 0,
    peak: 0,
    async decide(i: DecisionInput): Promise<DecisionOutput> {
      d.inFlight++
      d.peak = Math.max(d.peak, d.inFlight)
      await Bun.sleep(i.agentId === 'a' ? 30 : 5)
      d.inFlight--
      return {
        raw: i.agentId,
        action: { type: 'wait' },
        usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.5 },
      }
    },
  }
  return d
}

describe('createScheduler', () => {
  it('should_never_run_more_than_max_concurrent_decisions', async () => {
    const d = slow()
    const s = createScheduler(d, budget({ maxConcurrent: 2 }))
    await s.decideAll(['a', 'b', 'c', 'd', 'e'].map(input))
    expect(d.peak).toBe(2)
  })

  it('should_return_outputs_in_input_order_whatever_finishes_first', async () => {
    const s = createScheduler(slow(), budget({ maxConcurrent: 5 }))
    const r = await s.decideAll(['a', 'b', 'c'].map(input))
    expect([...r.outputs.keys()]).toEqual(['a', 'b', 'c'])
    expect(r.exhausted).toBe(false)
    expect(s.usage()).toEqual({ calls: 3, promptTokens: 300, completionTokens: 30, costUsd: 1.5 })
  })

  it('should_refuse_calls_beyond_max_calls', async () => {
    const s = createScheduler(slow(), budget({ maxCalls: 2 }))
    const r = await s.decideAll(['a', 'b', 'c'].map(input))
    expect([...r.outputs.keys()]).toEqual(['a', 'b'])
    expect(r.exhausted).toBe(true)
    expect(s.usage().calls).toBe(2)
  })

  it('should_refuse_once_cost_or_tokens_are_at_cap', async () => {
    const cost = createScheduler(slow(), budget({ maxCostUsd: 1, maxConcurrent: 1 }))
    const r = await cost.decideAll(['a', 'b', 'c'].map(input))
    expect(r.outputs.size).toBe(2)
    expect(r.exhausted).toBe(true)
    const tokens = createScheduler(slow(), budget({ maxCompletionTokens: 10, maxConcurrent: 1 }))
    expect((await tokens.decideAll(['a', 'b'].map(input))).outputs.size).toBe(1)
    const prompt = createScheduler(slow(), budget({ maxPromptTokens: 100, maxConcurrent: 1 }))
    expect((await prompt.decideAll(['a', 'b'].map(input))).outputs.size).toBe(1)
  })

  it('should_carry_on_from_the_usage_it_resumed_with', async () => {
    const s = createScheduler(slow(), budget({ maxCalls: 3 }), {
      calls: 2,
      promptTokens: 5,
      completionTokens: 5,
      costUsd: 0.25,
    })
    const r = await s.decideAll(['a', 'b'].map(input))
    expect(r.outputs.size).toBe(1)
    expect(r.exhausted).toBe(true)
    expect(s.usage()).toEqual({ calls: 3, promptTokens: 105, completionTokens: 15, costUsd: 0.75 })
  })
})
