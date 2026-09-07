import { describe, expect, test } from 'bun:test'
import type { Price } from '@aidcrew/prices'
import { money } from '@aidcrew/prices'
import { comparedTo, jobCost, jobCostSaid } from './job-cost.ts'

/** Dollars per token, as the price table keeps them. */
const perMillion = (input: number, output: number): Price => ({
  input: input / 1e6,
  output: output / 1e6,
  cacheRead: input / 1e7,
  cacheWrite: 0,
  from: 'a test',
})

const prices: Record<string, Price> = {
  'glm-5.3-flash': perMillion(0.07, 0.25),
  'deepseek-v4-flash': perMillion(0.09, 0.17),
  'claude-sonnet-5': perMillion(2, 10),
  'gpt-5': perMillion(1.25, 10),
}
const priceFor = (model: string) => prices[model]

const agents = [
  {
    id: 'architect',
    task: 'main',
    model: 'glm-5.3-flash',
    usage: { inputTokens: 40_000, outputTokens: 4_000 },
  },
  {
    id: 'coder',
    task: 'main',
    model: 'deepseek-v4-flash',
    usage: { inputTokens: 100_000, outputTokens: 12_000 },
  },
  {
    id: 'other',
    task: 'docs',
    model: 'gpt-5',
    usage: { inputTokens: 900_000, outputTokens: 1_000 },
  },
]

describe('what a job cost', () => {
  test('adds up the agents on the job and nobody else', () => {
    const cost = jobCost(agents, 'main', priceFor)

    expect(cost.tokens).toBe(156_000)
    // 40k×0.07 + 4k×0.25 + 100k×0.09 + 12k×0.17, per million.
    expect(cost.dollars).toBeCloseTo((2.8 + 1 + 9 + 2.04) / 1000, 6)
    expect(cost.models).toEqual(['glm-5.3-flash', 'deepseek-v4-flash'])
  })

  test('says what the same tokens would have cost on the models people compare against', () => {
    // The number that makes the case for a cheap coder is not what it cost;
    // it is what it would have cost on the model everybody defaults to.
    const usage = { inputTokens: 140_000, outputTokens: 16_000 }

    const compared = comparedTo(usage, priceFor, ['claude-sonnet-5', 'gpt-5'])

    expect(compared.map((one) => one.model)).toEqual(['claude-sonnet-5', 'gpt-5'])
    expect(compared[0]?.dollars).toBeCloseTo((280 + 160) / 1000, 6)
    expect(compared[1]?.dollars).toBeCloseTo((175 + 160) / 1000, 6)
  })

  test('leaves out a comparison model nobody has a price for', () => {
    expect(comparedTo({ inputTokens: 1, outputTokens: 1 }, priceFor, ['nothing-known'])).toEqual([])
  })

  test('is one line the pane can show', () => {
    const said = jobCostSaid(agents, 'main', priceFor, ['claude-sonnet-5', 'gpt-5'])

    expect(said).toContain('156k tokens')
    expect(said).toContain(money((2.8 + 1 + 9 + 2.04) / 1000))
    expect(said).toContain('glm-5.3-flash + deepseek-v4-flash')
    expect(said).toContain(`on claude-sonnet-5 ≈ ${money((280 + 160) / 1000)}`)
    expect(said).toContain(`on gpt-5 ≈ ${money((175 + 160) / 1000)}`)
  })

  test('says nothing for a job nothing was spent on', () => {
    expect(jobCostSaid(agents, 'idle', priceFor, ['gpt-5'])).toBeUndefined()
  })

  test('shows the tokens and no money when no price is known', () => {
    const said = jobCostSaid(agents, 'main', () => undefined, ['gpt-5'])

    expect(said).toContain('156k tokens')
    expect(said).not.toContain('$')
    expect(said).not.toContain('¢')
  })
})
