import type { Decider, DecisionInput, DecisionOutput, ExchangeStore } from '../contracts.ts'
import { buildMessages } from './prompt.ts'

/**
 * Records every exchange so a run can be replayed. The request holds what was
 * asked — messages, model, sampling params — never a key or a header.
 */
export class RecordingDecider implements Decider {
  readonly name: string
  readonly oracle?: boolean

  constructor(
    private readonly inner: Decider,
    private readonly store: ExchangeStore,
    private readonly runId: string,
    private readonly params: Record<string, number | string> = {},
  ) {
    this.name = inner.name
    if (inner.oracle) this.oracle = true
  }

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    const out = await this.inner.decide(input)
    this.store.recordExchange({
      runId: this.runId,
      agentId: input.agentId,
      tick: input.tick,
      path: input.path,
      request: { messages: buildMessages(input), model: this.inner.name, params: this.params },
      response: out.raw,
      usage: out.usage ?? null,
    })
    return out
  }
}
