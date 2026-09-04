import type { Usage } from '@aidcrew/core'
import { addUsage, tokensOf } from '@aidcrew/core'
import type { Price } from '@aidcrew/prices'
import { costOf, money } from '@aidcrew/prices'

/**
 * What a job cost, and what it would have cost on the models people default
 * to.
 *
 * The figure that makes the case for a mixed team is not what the job cost;
 * it is that number beside what the same tokens would have been on the model
 * everybody reaches for first. A closed harness cannot show this, because it
 * has only the one model; here it is one line, said when a job comes home.
 */

/** The models a job is compared against: the two most people would otherwise have used. */
export const COMPARED_TO = ['claude-sonnet-5', 'gpt-5']

type Spender = { task: string; model: string; usage: Usage }
type PriceFor = (model: string) => Price | undefined

export type JobCost = {
  /** Input and output tokens of every agent on the job, added up. */
  tokens: number
  /** What those cost, where every model on the job has a price. */
  dollars: number | undefined
  /** The models the work ran on, in the order the agents were started. */
  models: string[]
  usage: Usage
}

/** The tokens and the money the agents on one job spent, and on what. */
export function jobCost(agents: Spender[], task: string, priceFor: PriceFor): JobCost {
  const onJob = agents.filter((agent) => agent.task === task)
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let dollars: number | undefined = 0
  const models: string[] = []

  for (const agent of onJob) {
    usage = addUsage(usage, agent.usage)
    if (!models.includes(agent.model)) models.push(agent.model)
    const cost = costOf(agent.usage, priceFor(agent.model))
    // One agent without a price makes the total unknowable rather than low:
    // a figure that is quietly a fraction of the truth is the one failure
    // the meter must never have.
    dollars = dollars === undefined || cost === undefined ? undefined : dollars + cost
  }

  return { tokens: tokensOf(usage), dollars, models, usage }
}

/** The same tokens priced on other models — only the ones with a known price. */
export function comparedTo(
  usage: Usage,
  priceFor: PriceFor,
  references: string[],
): { model: string; dollars: number }[] {
  return references.flatMap((model) => {
    const dollars = costOf(usage, priceFor(model))
    return dollars === undefined ? [] : [{ model, dollars }]
  })
}

/**
 * One line for the pane: the job's tokens and money, on which models, and
 * what it would have been elsewhere. Nothing for a job nothing was spent on.
 */
export function jobCostSaid(
  agents: Spender[],
  task: string,
  priceFor: PriceFor,
  references = COMPARED_TO,
): string | undefined {
  const cost = jobCost(agents, task, priceFor)
  if (cost.tokens === 0) return undefined

  const tokens = `${Math.round(cost.tokens / 1000)}k tokens`
  const spent = cost.dollars === undefined ? tokens : `${tokens}, ${money(cost.dollars)}`
  const on = cost.models.length > 0 ? ` on ${cost.models.join(' + ')}` : ''
  const elsewhere = comparedTo(cost.usage, priceFor, references)
    .filter((other) => !cost.models.includes(other.model))
    .map((other) => `on ${other.model} ≈ ${money(other.dollars)}`)
    .join(', ')

  return `this job: ${spent}${on}${elsewhere === '' ? '' : ` — ${elsewhere}`}`
}
