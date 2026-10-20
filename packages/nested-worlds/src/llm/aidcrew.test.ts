import { describe, expect, it } from 'bun:test'
import { ALL_ACTIONS } from '../actions.ts'
import type { DecisionInput } from '../contracts.ts'
import { generateWorld } from '../world/generate.ts'
import { observe } from '../world/observe.ts'
import {
  type AidcrewDelta,
  type AidcrewProvider,
  type AidcrewRequest,
  aidcrewDecider,
} from './aidcrew.ts'

const input = (tick = 0, agentId = 'ada'): DecisionInput => ({
  runId: 'r1',
  agentId,
  tick,
  path: '',
  condition: 'A',
  observation: observe(generateWorld(1, 2), agentId, [], null),
  memory: { episodes: [], notes: [], board: [], strategy: '' },
  allowedActions: ALL_ACTIONS,
})

function stub(
  chunks: string[],
  usage?: Extract<AidcrewDelta, { type: 'done' }>['usage'],
): { provider: AidcrewProvider; seen: AidcrewRequest[] } {
  const seen: AidcrewRequest[] = []
  return {
    seen,
    provider: {
      id: 'stub',
      async *send(request: AidcrewRequest) {
        seen.push(request)
        for (const chunk of chunks) yield { type: 'text_delta', text: chunk }
        if (usage) yield { type: 'done', stopReason: 'end_turn', usage }
      },
    },
  }
}

describe('aidcrewDecider', () => {
  it('should_name_itself_after_provider_and_model_without_the_oracle_flag', () => {
    const { provider } = stub([])
    const d = aidcrewDecider({ provider, providerId: 'opencode-go', model: 'muse-spark' })
    expect(d.name).toBe('aidcrew:opencode-go/muse-spark')
    expect(d.oracle).toBeUndefined()
  })

  it('should_stream_text_deltas_into_a_parsed_decision_with_usage', async () => {
    const { provider, seen } = stub(
      ['{"action":', '{"type":"move","dir":"N"}', ',"rationale":"north looks open"}'],
      { inputTokens: 100, outputTokens: 20, chargedUsd: 0.001 },
    )
    const d = aidcrewDecider({ provider, providerId: 'opencode-go', model: 'muse-spark' })
    const out = await d.decide(input(1))
    expect(out.action).toEqual({ type: 'move', dir: 'N' })
    expect(out.rationale).toBe('north looks open')
    expect(out.raw).toBe('{"action":{"type":"move","dir":"N"},"rationale":"north looks open"}')
    expect(out.usage).toEqual({ promptTokens: 100, completionTokens: 20, costUsd: 0.001 })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.model).toBe('muse-spark')
    expect(seen[0]?.tools).toEqual([])
    expect(seen[0]?.system).toContain('ONE JSON object')
    expect(seen[0]?.messages).toHaveLength(1)
    expect(seen[0]?.messages[0]?.role).toBe('user')
  })

  it('should_answer_wait_with_the_raw_kept_when_the_model_is_unparsable', async () => {
    const { provider } = stub(['just thinking out loud, no decision here'])
    const d = aidcrewDecider({ provider, providerId: 'opencode-go', model: 'muse-spark' })
    const out = await d.decide(input(2))
    expect(out.action).toEqual({ type: 'wait' })
    expect(out.raw).toBe('just thinking out loud, no decision here')
  })

  it('should_answer_wait_instead_of_throwing_when_the_provider_fails', async () => {
    const failing: AidcrewProvider = {
      id: 'stub',
      send(_request: AidcrewRequest): AsyncIterable<AidcrewDelta> {
        throw new Error('connection reset')
      },
    }
    const d = aidcrewDecider({ provider: failing, providerId: 'opencode-go', model: 'muse-spark' })
    const out = await d.decide(input(3))
    expect(out.action).toEqual({ type: 'wait' })
    expect(out.raw).toContain('connection reset')
  })
})
