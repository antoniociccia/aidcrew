import type { Decider, DecisionInput, DecisionOutput } from '../contracts.ts'
import { parseDecision } from './parse.ts'
import { buildMessages } from './prompt.ts'

/** Plays a script as if it were a model: the action goes out as text and is read back. */
export class FakeDecider implements Decider {
  readonly name = 'fake'

  constructor(private readonly script: (input: DecisionInput) => unknown) {}

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    const raw = JSON.stringify({ action: this.script(input), rationale: 'scripted' })
    const prompt = buildMessages(input)
      .map((m) => m.content)
      .join('\n')
    const parsed = parseDecision(raw)
    return {
      raw,
      action: parsed.action,
      ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
      usage: { promptTokens: Math.ceil(prompt.length / 4), completionTokens: 20, costUsd: 0 },
    }
  }
}
