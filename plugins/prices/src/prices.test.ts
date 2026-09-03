import { describe, expect, test } from 'bun:test'
import type { Allowance, Window } from './allowance.ts'
import {
  aboutThePlan,
  allLeft,
  crossings,
  fromMeter,
  fromUsage,
  left,
  planReset,
  tightest,
} from './allowance.ts'
import { createListingPrices, loadAllowance } from './plugin.ts'
import { refreshGate } from './refresh.ts'
import {
  costOf,
  FLAT_PLAN,
  fromConfig,
  fromListing,
  money,
  priceOf,
  splitOf,
  totalOf,
} from './table.ts'

const listing = {
  data: [
    {
      id: 'anthropic/claude-opus-5',
      pricing: { prompt: '0.00001', completion: '0.00005', web_search: '0.01' },
    },
    { id: 'free/thing', pricing: { prompt: '0', completion: '0' } },
    { id: 'says-nothing', object: 'model' },
    { id: 'half-a-price', pricing: { prompt: '0.001' } },
    {
      // The key names are read from the live listing, not guessed: of its 396
      // models, 235 publish input_cache_read and 74 publish input_cache_write.
      id: 'cached/both',
      pricing: {
        prompt: '0.000005',
        completion: '0.000025',
        input_cache_read: '0.0000005',
        input_cache_write: '0.00000625',
      },
    },
    {
      id: 'cached/read-only',
      pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005' },
    },
  ],
}

describe('reading a price list', () => {
  test('takes the price per input and output token', () => {
    const table = fromListing(listing, 'openrouter')

    expect(table['anthropic/claude-opus-5']).toEqual({
      input: 0.00001,
      output: 0.00005,
      from: 'openrouter',
    })
  })

  test('keeps a free model, which is a price and not an absence', () => {
    expect(fromListing(listing, 'openrouter')['free/thing']).toMatchObject({
      input: 0,
      output: 0,
    })
  })

  test('leaves out a model that states nothing', () => {
    // Most services publish no prices at all. That is a real answer.
    expect(fromListing(listing, 'openrouter')['says-nothing']).toBeUndefined()
  })

  test('leaves out half a price, which would look authoritative and be wrong', () => {
    expect(fromListing(listing, 'openrouter')['half-a-price']).toBeUndefined()
  })

  test('reads the cache rates a listing publishes', () => {
    // On a coding turn the cached read is most of the input, so a table
    // without these rates is not a rough table — it is a tenth of one.
    expect(fromListing(listing, 'openrouter')['cached/both']).toEqual({
      input: 0.000005,
      output: 0.000025,
      cacheRead: 0.0000005,
      cacheWrite: 0.00000625,
      from: 'openrouter',
    })
  })

  test('takes the cache rates it has, since a service may price reads and not writes', () => {
    // Deliberately not all-or-nothing, unlike prompt and completion: on the
    // live listing 235 models publish a read rate and only 74 publish a write
    // one, so demanding both would throw away most of what is published.
    const price = fromListing(listing, 'openrouter')['cached/read-only']

    expect(price?.cacheRead).toBe(0.0000005)
    expect(price?.cacheWrite).toBeUndefined()
  })

  test('is not upset by a body of the wrong shape', () => {
    expect(fromListing({ nope: true }, 'x')).toEqual({})
    expect(fromListing('not json at all', 'x')).toEqual({})
  })
})

describe('finding the price of a model', () => {
  const table = fromListing(listing, 'openrouter')

  test('finds it by the name it was asked for', () => {
    expect(priceOf(table, 'anthropic/claude-opus-5')?.input).toBe(0.00001)
  })

  test('finds it by the bare name, since the two spellings both turn up', () => {
    // A model is written with the vendor in front of it in one place and
    // without in another, and a miss would report a cost of nothing.
    expect(priceOf(table, 'claude-opus-5')?.input).toBe(0.00001)
  })

  test('says nothing for a model nobody has priced', () => {
    expect(priceOf(table, 'muse-spark-1.2-contributor')).toBeUndefined()
  })
})

describe('what a session cost', () => {
  const price = { input: 0.00001, output: 0.00005, from: 'openrouter' }

  test('adds up the tokens at their own rates', () => {
    expect(costOf({ inputTokens: 100_000, outputTokens: 20_000 }, price)).toBeCloseTo(2)
  })

  test('says nothing when nobody has priced the model', () => {
    // Unknown and free are different facts, and showing the first as the
    // second is how an interface tells a comfortable lie about a bill.
    expect(costOf({ inputTokens: 100, outputTokens: 100 }, undefined)).toBeUndefined()
  })

  test('prefers what the provider said over anything the table would compute', () => {
    // Measured on a recorded turn: the program that was actually being billed
    // said 16.5¢ and this table said 0.011¢, which is out by a factor of
    // fifteen hundred. A provider that knows its own cost is not a better
    // estimate than the table — it is the answer, and the table is what we
    // fall back to when nobody can tell us.
    const stated = costOf(
      {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 9000,
        cacheWriteTokens: 400,
        listedUsd: 0.165575,
      },
      price,
    )

    expect(stated).toBeCloseTo(0.165575, 10)
  })

  test('counts money charged and money drawn against a plan as both real', () => {
    // Adding them is only ever a no-op in practice, because one agent means
    // one provider means one basis. If both ever did appear, the sum overstates
    // the card — which is the direction a bill is allowed to be wrong in.
    expect(
      costOf({ inputTokens: 0, outputTokens: 0, chargedUsd: 0.25, listedUsd: 0.5 }, price),
    ).toBeCloseTo(0.75, 10)
  })

  test('prices every quantity when every rate is known', () => {
    // A tenth of the input rate to read, a quarter more than it to write,
    // which is roughly what the services that publish these charge.
    const full = { ...price, cacheRead: 0.000001, cacheWrite: 0.0000125 }

    expect(
      costOf(
        { inputTokens: 100, outputTokens: 10, cacheReadTokens: 9000, cacheWriteTokens: 400 },
        full,
      ),
    ).toBeCloseTo(0.0155, 10)
  })

  test('says nothing when the cache was used and nobody published a cache rate', () => {
    // The argument in one number. On a coding turn the cached read is most of
    // the input, so the input-and-output subtotal is a fraction of the bill
    // wearing the confidence of a whole one — and it is wrong in the
    // flattering direction, which is the one that cannot be recovered from.
    expect(
      costOf(
        { inputTokens: 100, outputTokens: 10, cacheReadTokens: 9000, cacheWriteTokens: 400 },
        price,
      ),
    ).toBeUndefined()
  })

  test('still prices a turn that never touched a cache', () => {
    // Strictness has to stay pointed at the quantity that is actually there,
    // or every plain turn loses its price along with the cached ones.
    expect(costOf({ inputTokens: 100_000, outputTokens: 20_000 }, price)).toBeCloseTo(2, 10)
  })

  test('takes a stated cost of nothing as a real answer, not as silence', () => {
    expect(costOf({ inputTokens: 100_000, outputTokens: 20_000, listedUsd: 0 }, price)).toBe(0)
  })
})

describe('a price stated by the project', () => {
  test('is taken as given, which is how a flat plan gets a number', () => {
    const table = fromConfig({ 'muse-spark-1.2': { input: 0, output: 0 } }, 'the project')

    expect(table['muse-spark-1.2']).toEqual({
      input: 0,
      output: 0,
      // Free of charge per token means free of charge for the cache too —
      // see the test below, which is the bug that put those two here.
      cacheRead: 0,
      cacheWrite: 0,
      from: 'the project',
    })
  })

  test('ignores an entry that is not a pair of numbers', () => {
    expect(fromConfig({ a: { input: 'free' }, b: 7 }, 'x')).toEqual({})
  })

  test('takes cache rates too, so a service the listing misses can still be priced', () => {
    const table = fromConfig(
      { 'muse-spark-1.2': { input: 0.000005, output: 0.000025, cacheRead: 0.0000005 } },
      'the project',
    )

    expect(table['muse-spark-1.2']).toEqual({
      input: 0.000005,
      output: 0.000025,
      cacheRead: 0.0000005,
      from: 'the project',
    })
  })

  test('a model stated free is free to cache too', () => {
    // The way a flat plan gets a number is `input = 0, output = 0`, and the
    // first cached turn then took the number away again: the cache was used,
    // no cache rate was stated, and `costOf` — rightly — refused to price a
    // quantity nobody had priced. Free means free.
    const price = fromConfig({ 'muse-spark-1.2': { input: 0, output: 0 } }, 'the project')[
      'muse-spark-1.2'
    ]

    expect(price).toMatchObject({ cacheRead: 0, cacheWrite: 0 })
    expect(
      costOf(
        { inputTokens: 100, outputTokens: 10, cacheReadTokens: 9000, cacheWriteTokens: 400 },
        price,
      ),
    ).toBe(0)
  })
})

describe('work that comes off a plan', () => {
  test('is charged nothing per token, cache included', () => {
    // A subscription is metered in windows, not tokens: the per-token answer
    // is zero, and the windows are shown beside it. Without a price the
    // agent could not be costed, and one agent that cannot be costed blanks
    // the total for the whole team — including the paid half of it.
    expect(
      costOf(
        { inputTokens: 100, outputTokens: 10, cacheReadTokens: 9000, cacheWriteTokens: 400 },
        FLAT_PLAN,
      ),
    ).toBe(0)
    expect(FLAT_PLAN.estimated).toBeFalsy()
  })
})

describe('showing money', () => {
  test('says free rather than nothing at all', () => {
    expect(money(0)).toBe('free')
  })

  test('uses tenths of a cent below a cent', () => {
    // "$0.00" beside an hour of work reads as free rather than as cheap, and
    // that difference is the argument for a mixed team.
    expect(money(0.0034)).toBe('0.3¢')
  })

  test('uses dollars once there are some', () => {
    expect(money(2.5)).toBe('$2.50')
    expect(money(42)).toBe('$42.0')
  })

  test('marks an estimate as one', () => {
    // A figure from a list in the repository is a guess about a bill, and a
    // guess drawn in the same type as a fact gets believed like one.
    expect(money(2.5, true)).toBe('~$2.50')
    expect(money(0.0034, true)).toBe('~0.3¢')
    expect(money(0, true)).toBe('~free')
  })

  test('does not turn a cent short of a dollar into a hundred cents', () => {
    expect(money(0.995)).toBe('$1.00')
    expect(money(0.994)).toBe('99¢')
  })

  test('says under a tenth of a cent rather than a zero that reads as free', () => {
    expect(money(0.00004)).toBe('<0.1¢')
  })

  test('does not write ten dollars with two decimals and eleven with one', () => {
    expect(money(9.996)).toBe('$10.0')
  })
})

describe('fetching a list', () => {
  test('asks the service and reads what it publishes', async () => {
    const source = createListingPrices()
    const seen: string[] = []

    const table = await source.load('openrouter', {
      baseUrl: 'https://example.test/api/v1/',
      apiKey: 'k',
      fetchImpl: async (url: string) => {
        seen.push(url)
        return new Response(JSON.stringify(listing))
      },
    })

    expect(seen).toEqual(['https://example.test/api/v1/models'])
    expect(table['anthropic/claude-opus-5']).toBeDefined()
  })

  test('comes back empty when the service will not say', async () => {
    const source = createListingPrices()

    const table = await source.load('opencode-go', {
      baseUrl: 'https://example.test/v1',
      fetchImpl: async () => new Response('nope', { status: 500 }),
    })

    expect(table).toEqual({})
  })

  test('is never the reason a session fails to start', async () => {
    const source = createListingPrices()

    const table = await source.load('somewhere', {
      baseUrl: 'https://example.test/v1',
      fetchImpl: async () => {
        throw new Error('the network is down')
      },
    })

    expect(table).toEqual({})
  })
})

describe('what is left of a plan', () => {
  const body = {
    usage: {
      rolling: { status: 'ok', percent: 3, resetsAt: '2026-08-28T16:55:33.470Z' },
      weekly: { status: 'ok', percent: 77, resetsAt: '2026-08-31T00:00:00.470Z' },
      monthly: { status: 'ok', percent: 38, resetsAt: '2026-09-24T10:02:30.470Z' },
    },
  }

  test('reads every window the service publishes', () => {
    const allowance = fromUsage(body, 'opencode-go')

    expect(allowance?.windows.map((window) => window.name).sort()).toEqual([
      'monthly',
      'rolling',
      'weekly',
    ])
  })

  test('keeps a window it has never heard of', () => {
    // A service that adds a daily allowance next month should show it without
    // a release here.
    const allowance = fromUsage(
      { usage: { daily: { percent: 5, status: 'ok', resetsAt: '2026-08-29T00:00:00Z' } } },
      'x',
    )

    expect(allowance?.windows[0]?.name).toBe('daily')
  })

  test('says nothing for a service that publishes nothing', () => {
    expect(fromUsage({}, 'x')).toBeUndefined()
    expect(fromUsage({ usage: {} }, 'x')).toBeUndefined()
  })

  test('shows the window closest to running out, not the first one', () => {
    // A plan with three allowances is limited by whichever is nearest its end.
    const allowance = fromUsage(body, 'opencode-go')

    expect(tightest(allowance as Allowance)?.name).toBe('weekly')
  })

  test('says how much is left and when it comes back', () => {
    const allowance = fromUsage(body, 'opencode-go') as Allowance
    const now = new Date('2026-08-30T00:00:00.000Z')

    expect(left(tightest(allowance) as Window, now)).toBe('23% weekly, back in 24h')
  })

  test('leaves out a reset that has already passed', () => {
    // The service has moved the window on and not told us yet; saying "back in
    // minus three hours" would be worse than saying nothing.
    const allowance = fromUsage(body, 'opencode-go') as Allowance
    const now = new Date('2026-09-01T00:00:00.000Z')

    expect(left(tightest(allowance) as Window, now)).toBe('23% weekly')
  })
})

describe('windows a provider reported about itself', () => {
  test('reads the windows a provider reported about itself', () => {
    // A second supplier for the same shape: one service publishes its windows
    // at an endpoint, another states them mid-stream, and everything that
    // reads an allowance carries on unchanged.
    const allowance = fromMeter(
      [
        { name: 'five_hour', usedFraction: 0.02, resetsAt: new Date('2026-08-30T14:10:00.000Z') },
        { name: 'seven_day', usedFraction: 0.23, resetsAt: new Date('2026-09-04T18:00:00.000Z') },
      ],
      'claude',
    )

    expect(allowance?.providerId).toBe('claude')
    expect(allowance?.windows.map((window) => window.percent)).toEqual([2, 23])
  })

  test('says nothing when there are no windows, rather than an empty plan', () => {
    expect(fromMeter([], 'claude')).toBeUndefined()
  })

  test('finds the tightest of them, the same as any other allowance', () => {
    const allowance = fromMeter(
      [
        { name: 'five_hour', usedFraction: 0.02, resetsAt: new Date('2026-08-30T14:10:00.000Z') },
        { name: 'seven_day', usedFraction: 0.23, resetsAt: new Date('2026-09-04T18:00:00.000Z') },
      ],
      'claude',
    )

    expect(allowance && tightest(allowance)?.name).toBe('seven_day')
  })
})

/**
 * What OpenCode Go answered at `/usage` on the morning of 2 September 2026,
 * to the letter, with the clock set to a little before it was asked.
 */
const goUsage = {
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-09-02T12:21:18.328Z' },
    weekly: { status: 'ok', percent: 22, resetsAt: '2026-09-07T00:00:00.328Z' },
    monthly: { status: 'ok', percent: 51, resetsAt: '2026-09-24T10:02:30.328Z' },
  },
}
const morning = { now: new Date('2026-09-02T09:19:00.000Z'), timeZone: 'UTC' }
const withWindow = (name: string, window: Record<string, unknown>) => ({
  usage: { ...goUsage.usage, [name]: { ...goUsage.usage[name as 'rolling'], ...window } },
})

describe('showing every window of a plan', () => {
  test('says all three on one row, shortest first, with when the tightest resets', () => {
    // Only the tightest answers "can I work right now" and hides "will this
    // last to the end of the month". Both are worth knowing, and with the
    // service's name in front the row still fits a tray. Used rather than
    // left, because that is the number the service publishes and the number
    // its own site shows, and two screens disagreeing by a subtraction is a
    // thing people stop to check.
    const line = allLeft(fromUsage(goUsage, 'opencode-go') as Allowance, morning)

    expect(line).toBe('go: 5h 1% · week 22% · month 51%, resets 12:21')
  })

  test('the reset shown is the soonest, until a window is nearly gone', () => {
    // At 1% the five-hour window resets first and is the one that moves; at
    // 96% the week is what stops you, and when it comes back is the only
    // reset worth reading.
    const nearlyGone = fromUsage(withWindow('weekly', { percent: 96 }), 'opencode-go')

    expect(allLeft(nearlyGone as Allowance, morning)).toBe(
      'go: 5h 1% · week 96% · month 51%, resets Mon 00:00',
    )
  })

  test('says a window the service has closed is exhausted', () => {
    const closed = fromUsage(withWindow('rolling', { percent: 100, status: 'exceeded' }), 'x')

    expect(allLeft(closed as Allowance, morning)).toBe(
      'x: 5h exhausted · week 22% · month 51%, resets 12:21',
    )
  })

  test('an unknown window still appears, after the ones we know', () => {
    const withNew = {
      usage: {
        ...goUsage.usage,
        fortnightly: { status: 'ok', percent: 10, resetsAt: '2026-09-05T00:00:00.000Z' },
      },
    }

    expect(allLeft(fromUsage(withNew, 'x') as Allowance, morning)).toBe(
      'x: 5h 1% · week 22% · month 51% · fortnightly 10%, resets 12:21',
    )
  })

  test('leaves out a reset that has already passed', () => {
    // The service has moved the window on and not told us yet; "resets
    // 12:21" beside a clock reading 14:00 is a number that looks stuck.
    const later = { now: new Date('2026-09-08T00:00:00.000Z'), timeZone: 'UTC' }
    const line = allLeft(
      fromUsage(
        {
          usage: {
            rolling: { status: 'ok', percent: 1, resetsAt: '2026-09-02T12:21:18.328Z' },
          },
        },
        'opencode-go',
      ) as Allowance,
      later,
    )

    expect(line).toBe('go: 5h 1%')
  })

  test('shows a reset days away as a day, and weeks away as a date', () => {
    const weekly = fromUsage(withWindow('weekly', { percent: 90 }), 'opencode-go')
    const monthly = fromUsage(withWindow('monthly', { percent: 90 }), 'opencode-go')

    expect(allLeft(weekly as Allowance, morning)).toContain('resets Mon 00:00')
    expect(allLeft(monthly as Allowance, morning)).toContain('resets 24 Sep')
  })
})

describe('a plan running out', () => {
  const before = fromUsage(goUsage, 'opencode-go') as Allowance

  test('is said once when a window passes 80%, and again at 95%', () => {
    // The tray shows the figure for as long as it is true; the transcript
    // has to say that it changed, or an afternoon ends on a plan nobody saw
    // running down.
    const high = fromUsage(withWindow('weekly', { percent: 82 }), 'opencode-go') as Allowance
    const nearlyGone = fromUsage(withWindow('weekly', { percent: 96 }), 'opencode-go') as Allowance

    expect(crossings(before, high, morning)).toEqual([
      'go: the week plan is 82% used, resets Mon 00:00',
    ])
    expect(crossings(high, nearlyGone, morning)).toEqual([
      'go: the week plan is nearly gone, 96% used, resets Mon 00:00',
    ])
  })

  test('says nothing while nothing has changed', () => {
    const still = fromUsage(withWindow('weekly', { percent: 84 }), 'opencode-go') as Allowance
    const high = fromUsage(withWindow('weekly', { percent: 82 }), 'opencode-go') as Allowance

    expect(crossings(before, before, morning)).toEqual([])
    expect(crossings(high, still, morning)).toEqual([])
  })

  test('says the plan is exhausted until it comes back', () => {
    // At 100%, or whenever the service says the window is not ok: the
    // status is the service's word for it and is trusted over the number.
    const spent = fromUsage(withWindow('rolling', { percent: 100 }), 'opencode-go') as Allowance
    const closed = fromUsage(
      withWindow('weekly', { percent: 60, status: 'exceeded' }),
      'opencode-go',
    ) as Allowance

    expect(crossings(before, spent, morning)).toEqual(['go: the 5h plan is exhausted until 12:21'])
    expect(crossings(before, closed, morning)).toEqual([
      'go: the week plan is exhausted until Mon 00:00',
    ])
  })

  test('starts by saying what is already high, since nobody saw it climb', () => {
    const high = fromUsage(withWindow('weekly', { percent: 82 }), 'opencode-go') as Allowance

    expect(crossings(undefined, high, morning)).toEqual([
      'go: the week plan is 82% used, resets Mon 00:00',
    ])
  })

  test('says when an exhausted window is back', () => {
    const spent = fromUsage(withWindow('rolling', { percent: 100 }), 'opencode-go') as Allowance

    expect(crossings(spent, before, morning)).toEqual(['go: the 5h plan is back, 1% used'])
  })
})

describe('an error about the plan', () => {
  test('can be told when the plan comes back', () => {
    // A 429 that says "quota exceeded" is a sentence with no time in it, and
    // the time is the only thing the person can do anything with.
    const plan = fromUsage(goUsage, 'opencode-go') as Allowance
    const nearlyGone = fromUsage(withWindow('weekly', { percent: 96 }), 'opencode-go') as Allowance

    expect(planReset(plan, morning)).toBe('the 5h plan resets 12:21')
    expect(planReset(nearlyGone, morning)).toBe('the week plan resets Mon 00:00')
  })

  test('knows nothing once every reset has passed', () => {
    const plan = fromUsage(goUsage, 'opencode-go') as Allowance
    const later = { now: new Date('2026-10-01T00:00:00.000Z'), timeZone: 'UTC' }

    expect(planReset(plan, later)).toBeUndefined()
  })

  test('is recognised by what it says, not by its status code', () => {
    // The code is gone by the time the sentence reaches a pane: the provider
    // folds it into the message.
    expect(aboutThePlan('opencode-go: You have exceeded your plan quota')).toBe(true)
    expect(aboutThePlan('zen: Too many requests, rate limit reached')).toBe(true)
    expect(aboutThePlan('zen returned 402 Payment Required: <html>')).toBe(true)
    expect(aboutThePlan('maximum context length exceeded')).toBe(false)
    expect(aboutThePlan('the write it had started never ran')).toBe(false)
  })
})

describe('asking again after a turn', () => {
  test('lets the first one straight through and holds the next for twenty seconds', () => {
    // Every turn end asks, and a team of five ending turns together would
    // ask five times in a second for one answer.
    const gate = refreshGate(20_000)

    expect(gate.wait(1_000)).toBe(0)
    gate.passed(1_000)
    expect(gate.wait(5_000)).toBe(16_000)
    expect(gate.wait(21_000)).toBe(0)
  })
})

describe('asking a service what is left', () => {
  test('reads the answer Go gives, at the address it gives it', async () => {
    const seen: string[] = []
    const found = await loadAllowance('opencode-go', {
      baseUrl: 'https://example.test/zen/go/v1/',
      apiKey: 'k',
      fetchImpl: async (url: string) => {
        seen.push(url)
        return new Response(JSON.stringify(goUsage))
      },
    })

    expect(seen).toEqual(['https://example.test/zen/go/v1/usage'])
    expect(found?.windows.map((window) => window.percent)).toEqual([1, 22, 51])
  })

  test('takes a page of HTML for the no it is, whatever the status', async () => {
    // Zen answers its 404 with a web page, and a gateway that answers 200
    // with one is not unheard of: neither is a plan.
    const html = '<!doctype html><html><body>Not found</body></html>'

    expect(
      await loadAllowance('zen', {
        baseUrl: 'https://example.test/zen/v1',
        fetchImpl: async () => new Response(html, { status: 404 }),
      }),
    ).toBeUndefined()
    expect(
      await loadAllowance('zen', {
        baseUrl: 'https://example.test/zen/v1',
        fetchImpl: async () => new Response(html, { status: 200 }),
      }),
    ).toBeUndefined()
  })
})

describe('adding up a session that cannot be fully priced', () => {
  test('is not the sum of the parts it happens to know', () => {
    // The failure this whole change exists to prevent, introduced by the
    // change itself: `costOf` began returning nothing where it used to
    // return a wrong number, and the caller filtered the nothings out and
    // summed the rest. So an agent that could not be priced did not read as
    // unknown — it quietly left the headline, and the headline went down.
    expect(totalOf([0.31, undefined, 0.04])).toBeUndefined()
  })

  test('adds up when every part is known', () => {
    expect(totalOf([0.31, 0.04])).toBeCloseTo(0.35, 10)
  })

  test('says nothing about a session with nobody in it', () => {
    expect(totalOf([])).toBeUndefined()
  })

  test('an agent that spent nothing costs nothing, priced or not', () => {
    // Otherwise a team with one agent on a model nobody publishes a price for
    // has no total at all, from the moment it opens, before anybody has spent
    // anything — which trains people to ignore a blank that means something.
    expect(costOf({ inputTokens: 0, outputTokens: 0 }, undefined)).toBe(0)
    expect(totalOf([0.31, costOf({ inputTokens: 0, outputTokens: 0 }, undefined)])).toBeCloseTo(
      0.31,
      10,
    )
  })
})

describe('two kinds of money on one team', () => {
  const cards = { inputTokens: 0, outputTokens: 0, chargedUsd: 0.31 }
  const plan = { inputTokens: 0, outputTokens: 0, listedUsd: 1.2 }

  test('says what was charged and what was drawn against a plan, apart', () => {
    // The whole pitch is one team on both at once, and folding them answers
    // neither question: not "what did this cost me", because it includes work
    // that came out of something already bought, and not "what would this have
    // cost", because it stops at the card.
    expect(splitOf([cards, plan])).toEqual({ charged: 0.31, listed: 1.2 })
  })

  test('says nothing about the side nobody used', () => {
    expect(splitOf([cards])).toEqual({ charged: 0.31 })
  })

  test('says nothing at all when no provider stated any', () => {
    expect(splitOf([{ inputTokens: 10, outputTokens: 2 }])).toEqual({})
  })
})

describe('a cost that is only part of the answer', () => {
  test('is no answer, rather than the part it happens to know', () => {
    // One provider stated what a turn cost, so the table is not consulted —
    // and the same agent had turns that stated nothing. Those tokens were
    // spent. Returning the stated figure alone prices them at zero, which is
    // under-reporting, which is the one direction this cannot come back from.
    const mixed = {
      inputTokens: 900,
      outputTokens: 400,
      chargedUsd: 0.3,
      unstatedTurns: 2,
    }

    expect(costOf(mixed, { input: 0.000003, output: 0.000015, from: 'a test' })).toBeUndefined()
  })

  test('is the stated figure when every turn stated one', () => {
    const spoken = { inputTokens: 10, outputTokens: 2, chargedUsd: 0.3 }

    expect(costOf(spoken, undefined)).toBeCloseTo(0.3, 10)
  })

  test('is the table when no turn stated anything', () => {
    // The ordinary case: the count is there and means nothing, because
    // nothing overrode the table.
    const quiet = { inputTokens: 1_000_000, outputTokens: 0, unstatedTurns: 4 }

    expect(costOf(quiet, { input: 0.000003, output: 0.000015, from: 'a test' })).toBeCloseTo(3, 10)
  })
})
