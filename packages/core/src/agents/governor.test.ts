import { describe, expect, test } from 'bun:test'
import { DEFAULT_LIMITS, DEFAULT_MAX_HOPS, Governor } from './governor.ts'

const limits = { maxHops: 3, maxTokensPerAgent: 1000, maxTotalTokens: 5000 }

describe('message hops', () => {
  test('lets a fresh message through', () => {
    const governor = new Governor(limits)

    expect(governor.allowDelivery({ from: 'a', to: 'b', text: 'hi', hops: 0 }).ok).toBe(true)
  })

  test('stops a message that has bounced too many times', () => {
    // Two agents answering each other is the natural failure of a mailbox
    // system, and it burns the budget silently.
    const governor = new Governor(limits)

    const verdict = governor.allowDelivery({ from: 'a', to: 'b', text: 'hi', hops: 3 })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toMatch(/hop/i)
  })

  test('refuses a message an agent sends to itself', () => {
    const governor = new Governor(limits)

    expect(governor.allowDelivery({ from: 'a', to: 'a', text: 'hi', hops: 0 }).ok).toBe(false)
  })
})

describe('token budget', () => {
  test('lets an agent work while it is under budget', () => {
    const governor = new Governor(limits)
    governor.charge('coder', { inputTokens: 100, outputTokens: 50 })

    expect(governor.allowTurn('coder').ok).toBe(true)
  })

  test('stops an agent that has spent its own budget', () => {
    const governor = new Governor(limits)
    governor.charge('coder', { inputTokens: 900, outputTokens: 200 })

    const verdict = governor.allowTurn('coder')

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toMatch(/budget/i)
  })

  test('keeps each agent budget separate', () => {
    const governor = new Governor(limits)
    governor.charge('coder', { inputTokens: 900, outputTokens: 200 })

    expect(governor.allowTurn('reviewer').ok).toBe(true)
  })

  test('stops everyone when the session total is spent', () => {
    const governor = new Governor({ ...limits, maxTokensPerAgent: 100_000 })
    for (const id of ['a', 'b', 'c']) {
      governor.charge(id, { inputTokens: 1000, outputTokens: 800 })
    }

    expect(governor.allowTurn('d').ok).toBe(false)
  })

  test('counts cache reads towards the budget, since they are billed', () => {
    const governor = new Governor(limits)
    governor.charge('coder', { inputTokens: 10, outputTokens: 10, cacheReadTokens: 2000 })

    expect(governor.allowTurn('coder').ok).toBe(false)
  })

  test('reports what an agent has spent', () => {
    const governor = new Governor(limits)
    governor.charge('coder', { inputTokens: 10, outputTokens: 5 })
    governor.charge('coder', { inputTokens: 20, outputTokens: 5 })

    expect(governor.spentBy('coder')).toBe(40)
  })

  test('reports the session total', () => {
    const governor = new Governor(limits)
    governor.charge('a', { inputTokens: 10, outputTokens: 0 })
    governor.charge('b', { inputTokens: 30, outputTokens: 0 })

    expect(governor.spentTotal()).toBe(40)
  })

  test('treats an absent limit as no limit', () => {
    const governor = new Governor({ maxHops: 3 })
    governor.charge('coder', { inputTokens: 10_000_000, outputTokens: 0 })

    expect(governor.allowTurn('coder').ok).toBe(true)
  })
})

describe('turn limit', () => {
  test('stops an agent that has taken too many turns', () => {
    const governor = new Governor({ ...limits, maxTurnsPerAgent: 2 })
    governor.recordTurn('coder')
    governor.recordTurn('coder')

    expect(governor.allowTurn('coder').ok).toBe(false)
  })

  test('counts turns per agent, not across the session', () => {
    const governor = new Governor({ ...limits, maxTurnsPerAgent: 2 })
    governor.recordTurn('coder')
    governor.recordTurn('coder')

    expect(governor.allowTurn('reviewer').ok).toBe(true)
  })
})

describe('message volume', () => {
  test('lets an agent send up to its allowance in one turn', () => {
    const governor = new Governor({ maxHops: 3, maxMessagesPerTurn: 2 })
    governor.beginTurn('coder')

    expect(governor.allowSend('coder').ok).toBe(true)
    governor.recordSend('coder')
    expect(governor.allowSend('coder').ok).toBe(true)
  })

  test('stops an agent flooding the team from a single turn', () => {
    // Hops bound how far a conversation travels; this bounds how wide it gets.
    const governor = new Governor({ maxHops: 3, maxMessagesPerTurn: 2 })
    governor.beginTurn('coder')
    governor.recordSend('coder')
    governor.recordSend('coder')

    const verdict = governor.allowSend('coder')

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toMatch(/this turn/)
  })

  test('counts messages that went, not attempts that were refused', () => {
    // A send that found nobody, or was dropped by the person, delivered
    // nothing — and was still one of the three, so the corrected attempt
    // could be the one refused.
    const governor = new Governor({ maxHops: 3, maxMessagesPerTurn: 1 })
    governor.beginTurn('coder')

    expect(governor.allowSend('coder').ok).toBe(true)
    expect(governor.allowSend('coder').ok).toBe(true)
    governor.recordSend('coder')
    expect(governor.allowSend('coder').ok).toBe(false)
  })

  test('gives the allowance back at the start of the next turn', () => {
    const governor = new Governor({ maxHops: 3, maxMessagesPerTurn: 1 })
    governor.beginTurn('coder')
    governor.recordSend('coder')

    governor.beginTurn('coder')

    expect(governor.allowSend('coder').ok).toBe(true)
  })

  test('counts each agent allowance separately', () => {
    const governor = new Governor({ maxHops: 3, maxMessagesPerTurn: 1 })
    governor.beginTurn('a')
    governor.beginTurn('b')
    governor.recordSend('a')

    expect(governor.allowSend('b').ok).toBe(true)
  })

  test('places no limit when none was set', () => {
    const governor = new Governor({ maxHops: 3 })
    governor.beginTurn('coder')

    for (let i = 0; i < 100; i++) {
      expect(governor.allowSend('coder').ok).toBe(true)
      governor.recordSend('coder')
    }
  })
})

describe('a pipeline is not a circle', () => {
  test('lets one instruction reach the end of a three-step job, three times', () => {
    // The task that found this: three tools, each of them architect hands to a
    // writer, the writer hands to a tester, the tester hands back. Nine
    // handoffs from one thing somebody typed, because the count only resets
    // when a person speaks. At four it was refused on the fourth — the second
    // tool — and told that the agents were talking in circles while they were
    // making linear progress on exactly what they were asked for.
    const governor = new Governor({ maxHops: DEFAULT_MAX_HOPS })
    const chain = ['architect', 'plugin-writer', 'tester']

    for (let hop = 1; hop <= 9; hop += 1) {
      const verdict = governor.allowDelivery({
        from: chain[(hop - 1) % 3] ?? 'x',
        to: chain[hop % 3] ?? 'y',
        text: 'carry on',
        hops: hop,
      })

      expect(verdict.ok).toBe(true)
    }
  })

  test('still stops a relay that has genuinely run away', () => {
    const governor = new Governor({ maxHops: DEFAULT_MAX_HOPS })

    const verdict = governor.allowDelivery({
      from: 'a',
      to: 'b',
      text: 'again',
      hops: DEFAULT_MAX_HOPS,
    })

    expect(verdict.ok).toBe(false)
  })

  test('says what happened rather than accusing them of looping', () => {
    // It counts distance travelled, not repetition, so it cannot tell a
    // pipeline from a circle — and saying "talking in circles" about a team
    // making progress sends somebody looking for a bug that is not there.
    const governor = new Governor({ maxHops: 2 })

    const verdict = governor.allowDelivery({ from: 'a', to: 'b', text: 'x', hops: 2 })

    expect(verdict.ok).toBe(false)
    const reason = verdict.ok ? '' : verdict.reason
    expect(reason).not.toContain('circles')
    expect(reason).toMatch(/without anybody|hand|relay/i)
  })
})

describe('what actually costs money', () => {
  test('a budget in tokens stops a runaway before it is expensive', () => {
    // The turn count was the only brake, and a turn is not a unit of money:
    // one can cost two hundred tokens or thirty thousand. Measured, an agent
    // spent 2,028,174 input tokens on one job — the same conversation sent
    // back fifty times — and what stopped it was running out of turns, at the
    // end, with the work nearly done.
    const governor = new Governor({ maxHops: 3, maxTokensPerAgent: 1_000 })
    governor.charge('coder', { inputTokens: 900, outputTokens: 50 })

    expect(governor.allowTurn('coder').ok).toBe(true)

    governor.charge('coder', { inputTokens: 100, outputTokens: 0 })
    const verdict = governor.allowTurn('coder')

    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.reason).toContain('budget')
  })

  test('counts the cached halves, which are most of a coding turn', () => {
    // They are billed, at a fraction — and a budget that ignored them would
    // let an agent spend ten times its allowance on a cached conversation.
    const governor = new Governor({ maxHops: 3, maxTokensPerAgent: 1_000 })
    governor.charge('coder', {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 500,
      cacheWriteTokens: 500,
    })

    expect(governor.allowTurn('coder').ok).toBe(false)
  })

  test('lets a real job finish before it starts counting turns against it', () => {
    // The default was forty, which one plugin with tests exceeded. Turns are
    // still bounded — a relay that never stops has to end somewhere — but the
    // bound is now far above any real job.
    expect(DEFAULT_LIMITS.maxTurnsPerAgent ?? 0).toBeGreaterThan(100)
  })

  test('puts no ceiling on what one agent may spend, by default', () => {
    // A token ceiling stops a runaway, and it also stops a large honest job:
    // on a service that caches nothing the whole conversation is re-sent every
    // turn, and a real feature crossed three million tokens while it was still
    // working. Cutting it off there is the failure it was meant to prevent,
    // paid for in wasted work rather than saved money. So the default is no
    // limit — a project that wants one sets maxTokensPerAgent — and the turn
    // count remains as the backstop against a loop that never ends.
    expect(DEFAULT_LIMITS.maxTokensPerAgent).toBeUndefined()
  })
})
