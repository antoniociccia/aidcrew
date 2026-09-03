import { describe, expect, test } from 'bun:test'
import { addUsage, tokensOf } from './types.ts'

describe('how many tokens a turn moved', () => {
  test('counts the cached halves, which are most of a coding turn', () => {
    // Six places summed input and output and stopped there. On a recorded
    // turn that reported 2 input, 4 output, 10,010 cached reads and 16,046
    // cache writes, every one of them printed "6 tokens" for a turn that
    // moved twenty-six thousand — including the summary a headless run ends
    // with, which is the only number a CI log carries.
    expect(
      tokensOf({
        inputTokens: 2,
        outputTokens: 4,
        cacheReadTokens: 10_010,
        cacheWriteTokens: 16_046,
      }),
    ).toBe(26_062)
  })

  test('counts a turn that touched no cache the way it always did', () => {
    expect(tokensOf({ inputTokens: 10, outputTokens: 5 })).toBe(15)
  })
})

describe('adding one usage to another', () => {
  test('keeps what the second one has nothing to say about', () => {
    // The bug this covers, which was live and persisted: a caller rebuilt the
    // running total by hand with a conditional spread per field, so when a
    // later agent had no cache reads the key was left off the object it was
    // building and the total's own cache reads were destroyed. Two agents on
    // one task, the first with five thousand cached reads and the second with
    // none, reported zero — order-dependent, in the flattering direction, and
    // written to disk.
    const first = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5000, chargedUsd: 0.3 }
    const second = { inputTokens: 4, outputTokens: 1 }

    expect(addUsage(first, second)).toEqual({
      inputTokens: 14,
      outputTokens: 3,
      cacheReadTokens: 5000,
      chargedUsd: 0.3,
      // The second spent tokens and said nothing about money, which is the
      // fact the next test is about.
      unstatedTurns: 1,
    })
  })

  test('keeps the two kinds of money apart', () => {
    const together = addUsage(
      { inputTokens: 0, outputTokens: 0, chargedUsd: 0.3 },
      { inputTokens: 0, outputTokens: 0, listedUsd: 1.2 },
    )

    expect(together.chargedUsd).toBeCloseTo(0.3, 10)
    expect(together.listedUsd).toBeCloseTo(1.2, 10)
  })

  test('says nothing about money neither of them mentioned', () => {
    const quiet = addUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 })

    expect(quiet.chargedUsd).toBeUndefined()
    expect(quiet.listedUsd).toBeUndefined()
  })
})

describe('a history that mixes stated money with turns that stated none', () => {
  test('is counted, so nothing can quietly price those tokens at zero', () => {
    // One provider states what a turn cost and the table is then not
    // consulted at all — which is right, and wrong the moment the same agent
    // has a turn that stated nothing. Those tokens were spent; folding them
    // into a figure built only from the turns that spoke prices them at zero,
    // and under-reporting is the one direction this cannot come back from.
    const spoke = { inputTokens: 10, outputTokens: 2, chargedUsd: 0.3 }
    const silent = { inputTokens: 900, outputTokens: 400 }

    expect(addUsage(spoke, silent).unstatedTurns).toBe(1)
  })

  test('says nothing about a history where everything spoke', () => {
    const both = addUsage(
      { inputTokens: 1, outputTokens: 1, chargedUsd: 0.1 },
      { inputTokens: 1, outputTokens: 1, chargedUsd: 0.2 },
    )

    expect(both.unstatedTurns).toBeUndefined()
  })

  test('counts them even when no turn ever spoke, and nobody minds', () => {
    // Always the true count, because money can arrive on a later turn and a
    // flag set at the time would have to be revisited. Whoever prices it
    // decides when the number matters: with nothing stated the table answers
    // for everything and this is ignored.
    const quiet = addUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 })

    expect(quiet.unstatedTurns).toBe(1)
  })

  test('adds up rather than counting one, when whole agents are merged', () => {
    // `addUsage` sums per-turn totals and also whole agents into a task
    // total. Counting one either way would say a task of three silent agents
    // had one silent turn.
    const first = { inputTokens: 1, outputTokens: 1, chargedUsd: 0.1, unstatedTurns: 2 }
    const second = { inputTokens: 1, outputTokens: 1, unstatedTurns: 3 }

    expect(addUsage(first, second).unstatedTurns).toBe(5)
  })
})
