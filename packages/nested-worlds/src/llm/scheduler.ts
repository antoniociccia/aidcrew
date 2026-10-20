// Runs one tick's decisions within the budget. A call is refused before it is
// made, never cut off after: once the budget is spent, the agents still
// waiting get no output and the tick reports itself exhausted.
import type {
  AgentId,
  Budget,
  BudgetUsage,
  Decider,
  DecisionOutput,
  Scheduler,
} from '../contracts.ts'

const ZERO: BudgetUsage = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }

export function createScheduler(
  decider: Decider,
  budget: Budget,
  initial: BudgetUsage = ZERO,
): Scheduler {
  const used: BudgetUsage = { ...initial }
  const spent = () =>
    used.calls + 1 > budget.maxCalls ||
    used.promptTokens >= budget.maxPromptTokens ||
    used.completionTokens >= budget.maxCompletionTokens ||
    used.costUsd >= budget.maxCostUsd

  return {
    usage: () => ({ ...used }),
    async decideAll(inputs) {
      const results: (DecisionOutput | undefined)[] = new Array(inputs.length)
      let nextIndex = 0
      let exhausted = false
      const worker = async () => {
        while (!exhausted && nextIndex < inputs.length) {
          if (spent()) {
            exhausted = true
            return
          }
          const i = nextIndex++
          used.calls += 1
          const out = await decider.decide(inputs[i] as (typeof inputs)[number])
          if (out.usage) {
            used.promptTokens += out.usage.promptTokens
            used.completionTokens += out.usage.completionTokens
            used.costUsd += out.usage.costUsd
          }
          results[i] = out
        }
      }
      const width = Math.max(1, Math.min(budget.maxConcurrent, inputs.length))
      await Promise.all(Array.from({ length: width }, worker))
      // Built in input order, so the map reads the same however the calls raced.
      const outputs = new Map<AgentId, DecisionOutput>()
      inputs.forEach((input, i) => {
        const out = results[i]
        if (out) outputs.set(input.agentId, out)
      })
      return { outputs, exhausted }
    },
  }
}
