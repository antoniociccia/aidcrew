import type { Decider, DecisionInput, DecisionOutput, ExchangeStore } from '../contracts.ts'
import { parseDecision } from './parse.ts'

/** Answers from a recorded run only. A missing exchange is an error, never a live call. */
export class ReplayDecider implements Decider {
  readonly name = 'replay'

  constructor(
    private readonly store: ExchangeStore,
    private readonly replayOf: string,
  ) {}

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    const rec = this.store.findExchange(this.replayOf, input.agentId, input.tick, input.path)
    if (!rec) {
      throw new Error(
        `no recorded exchange in run ${this.replayOf} for ${input.agentId} at tick ${input.tick} (path "${input.path}")`,
      )
    }
    const parsed = parseDecision(rec.response)
    // A replay spends nothing, so it reports no usage against the budget.
    return {
      raw: rec.response,
      action: parsed.action,
      ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
    }
  }
}
