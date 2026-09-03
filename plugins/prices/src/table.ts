import type { Usage } from '@aidcrew/core'

/**
 * What a turn costs, when anybody will say.
 *
 * Prices are per token and in dollars, which is how every provider that
 * publishes them states it. Kept as numbers rather than cents because the
 * figures are small enough that cents would round most turns to zero.
 */

export type Price = {
  /** Dollars per input token. */
  input: number
  /** Dollars per output token. */
  output: number
  /**
   * Dollars per token served from a cache, which is roughly a tenth of the
   * input rate — and on a coding turn is most of the input.
   */
  cacheRead?: number
  /**
   * Dollars per token written into a cache, which costs more than plain input.
   *
   * One rate, and Anthropic has two: a five-minute entry is billed at 1.25x
   * the input rate and a one-hour entry at 2x. Pricing a one-hour write from a
   * five-minute rate is 37.5% low on that component — flattering, which is the
   * direction this must never be.
   *
   * Unreachable today, and named here rather than left to be rediscovered:
   * the provider that reports the distinction states its own dollars, so no
   * table prices its tokens, and the direct Anthropic provider never asks for
   * a cache at all. It becomes reachable the moment one of those changes, and
   * what it needs then is two fields here and two counts on `Usage`: the
   * Anthropic payload already reports `cache_creation.ephemeral_1h_input_tokens`
   * beside the five-minute one, so the number is in hand and only the shape is
   * missing.
   */
  cacheWrite?: number
  /** Where the figure came from, so a surprising bill can be traced. */
  from: string
  /**
   * Whether this is a list price rather than something the service said.
   *
   * A figure from a table in this repository is a guess about a bill, and a
   * guess drawn in the same type as a fact gets believed like one — so it is
   * carried through to the screen, which puts a tilde in front of it.
   */
  estimated?: boolean
}

/**
 * The price of work that comes off a plan: nothing, per token.
 *
 * A subscription is metered in windows, not tokens, so the per-token answer
 * really is zero and the windows are shown beside it. Given a price rather
 * than left unpriced because one agent that cannot be costed blanks the total
 * for the whole team — including the half of it that is on a card.
 */
export const FLAT_PLAN: Price = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  from: 'a plan, which is metered in windows rather than tokens',
}

export type PriceTable = Record<string, Price>

/**
 * What this usage cost, or nothing when nobody has said what the model costs.
 *
 * Undefined rather than zero: a model whose price is unknown and a model that
 * is free are different facts, and showing the first as the second is how an
 * interface tells a comfortable lie about a bill.
 */
export function costOf(usage: Usage, price: Price | undefined): number | undefined {
  // A provider that reports its own cost is the thing being billed, so its
  // figure is not a better estimate than the table — it is the answer, and the
  // table is not consulted at all. Measured on a recorded turn: the program
  // said 16.5¢ and this table said 0.011¢, out by a factor of fifteen hundred.
  // Even a cache-aware table was still 36% low on that turn, because the write
  // was billed at the one-hour rate and no single rate can be both.
  if (usage.chargedUsd !== undefined || usage.listedUsd !== undefined) {
    // Unless some of it never spoke. Those turns spent tokens, and a figure
    // built only from the turns that stated a cost prices them at zero — a
    // confident understatement, arrived at by two correct rules meeting. The
    // tokens of the silent turns cannot be told apart from the rest once
    // summed, so the honest answer is that this is half an answer.
    if ((usage.unstatedTurns ?? 0) > 0) return undefined
    return (usage.chargedUsd ?? 0) + (usage.listedUsd ?? 0)
  }

  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0

  // A turn that moved nothing cost nothing, whoever publishes what. Without
  // this, a team with one agent on an unpriced model has no total from the
  // moment it opens, before anybody has spent anything — and a blank that is
  // there from the start is a blank people learn to look past.
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
    return 0
  }

  if (!price) return undefined

  // Nothing rather than a subtotal. On a coding turn the cached read is most
  // of the input, so an input-and-output figure is a tenth of the bill wearing
  // the confidence of a whole one — and it is wrong in the flattering
  // direction, which is the one this meter cannot come back from. Measured:
  // 0.15¢ against 1.55¢ on the turn in the test below.
  //
  // Only the quantities actually present are demanded, so a turn that never
  // touched a cache is still priced by a table that says nothing about caches.
  if (cacheRead > 0 && price.cacheRead === undefined) return undefined
  if (cacheWrite > 0 && price.cacheWrite === undefined) return undefined

  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    cacheRead * (price.cacheRead ?? 0) +
    cacheWrite * (price.cacheWrite ?? 0)
  )
}

/**
 * Reads prices out of a model listing that carries them.
 *
 * OpenRouter states them per model as strings; other services that speak the
 * same dialect either do the same or say nothing, and saying nothing is a
 * perfectly good answer that this returns as an empty table.
 */
export function fromListing(body: unknown, from: string): PriceTable {
  const models = (body as { data?: unknown[] })?.data
  if (!Array.isArray(models)) return {}

  const table: PriceTable = {}
  for (const model of models) {
    const id = (model as { id?: unknown }).id
    const pricing = (model as { pricing?: Record<string, unknown> }).pricing
    if (typeof id !== 'string' || !pricing) continue

    const input = asNumber(pricing.prompt)
    const output = asNumber(pricing.completion)
    // Both or neither: half a price would be worse than none, because the
    // total would look authoritative and be wrong.
    if (input === undefined || output === undefined) continue

    // The cache rates are deliberately not all-or-nothing, unlike the pair
    // above: a service may publish a read rate and no write one, and on the
    // live listing most of them do — 235 of 396 models state a read rate and
    // 74 a write one. Demanding both would throw away most of what is there.
    const cacheRead = asNumber(pricing.input_cache_read)
    const cacheWrite = asNumber(pricing.input_cache_write)

    table[id] = {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      from,
    }
  }

  return table
}

/** A price stated in the project config rather than fetched. */
export function fromConfig(stated: Record<string, unknown>, from: string): PriceTable {
  const table: PriceTable = {}

  for (const [id, value] of Object.entries(stated)) {
    const stated = value as { input?: unknown; output?: unknown } & Record<string, unknown>
    const input = asNumber(stated?.input)
    const output = asNumber(stated?.output)
    if (input === undefined || output === undefined) continue

    // Free means free, cache included. Stating `input = 0, output = 0` is how
    // a project prices a model it pays nothing per token for, and the first
    // cached turn then took the number away again: the cache was used, no
    // cache rate was stated, and `costOf` — rightly — refuses to price a
    // quantity nobody has priced.
    const free = input === 0 && output === 0
    const cacheRead = asNumber(stated?.cacheRead) ?? (free ? 0 : undefined)
    const cacheWrite = asNumber(stated?.cacheWrite) ?? (free ? 0 : undefined)

    table[id] = {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      from,
    }
  }

  return table
}

/**
 * The price for a model, trying the name it was asked for and the bare one.
 *
 * A model is written `anthropic/claude-opus-5` in one place and
 * `claude-opus-5` in another, and a table missing the spelling in front of it
 * would report a cost of nothing for a model that costs plenty.
 */
export function priceOf(table: PriceTable, model: string): Price | undefined {
  const bare = model.includes('/') ? (model.split('/').pop() ?? model) : model
  if (table[model]) return table[model]
  if (table[bare]) return table[bare]

  return Object.entries(table).find(([id]) => id.endsWith(`/${bare}`))?.[1]
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Money, at the scale a coding session actually reaches.
 *
 * Under a cent it is shown in tenths of one, because "$0.00" beside an hour of
 * work reads as free rather than as cheap, and the difference between free and
 * cheap is the argument for running a mixed team at all.
 */
export function money(dollars: number, estimated = false): string {
  const mark = estimated ? '~' : ''
  if (dollars === 0) return `${mark}free`
  // Under a tenth of a cent, said as that rather than rounded to "0.0¢",
  // which reads as a bug in the meter.
  if (dollars < 0.00005) return `${mark}<0.1¢`
  if (dollars < 0.01) return `${mark}${(dollars * 100).toFixed(1)}¢`
  // The thresholds are where the rounding lands, not where the number is:
  // 0.995 shown in cents is "100¢", which is a dollar written the long way,
  // and 9.996 with two decimals is "$10.00" beside "$10.0" for the next turn.
  // Rounded before it is formatted, not by it: 0.995 is 0.99499… in binary,
  // so `toFixed(2)` reads it down to "$0.99" while the threshold above has
  // already called it a dollar.
  const cents = Math.round(dollars * 100)
  if (cents < 100) return `${mark}${cents}¢`
  const places = cents < 1000 ? 2 : 1
  return `${mark}$${(Math.round(dollars * 10 ** places) / 10 ** places).toFixed(places)}`
}

/**
 * Whether the figure on screen is a guess rather than a bill.
 *
 * Only when it is both a guess and about money: a turn that spent nothing
 * costs nothing however it was priced, and a provider that stated its own
 * charge has told us the answer.
 */
export function isEstimate(usage: Usage, price: Price | undefined): boolean {
  if (usage.chargedUsd !== undefined || usage.listedUsd !== undefined) return false
  if (price?.estimated !== true) return false
  return tokensSpent(usage) > 0
}

function tokensSpent(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  )
}

/**
 * What a session cost, or nothing if any part of it cannot be priced.
 *
 * Not the sum of the parts it happens to know. `costOf` answers nothing where
 * it cannot answer honestly, and a caller that drops those and adds up the
 * rest turns a careful blank into a confident understatement — the one
 * direction this meter cannot come back from, arrived at by two correct steps
 * in a row.
 */
export function totalOf(costs: (number | undefined)[]): number | undefined {
  if (costs.length === 0) return undefined
  if (costs.some((cost) => cost === undefined)) return undefined
  return costs.reduce((sum: number, cost) => sum + (cost ?? 0), 0)
}

/**
 * What was charged and what was drawn against a plan, kept apart.
 *
 * The two are real money and not the same money, and folding them answers
 * neither question a mixed team asks: not "what did this cost me", because it
 * would include work that came out of something already bought, and not "what
 * would this have cost", because it stops at the card. One team on a
 * subscription and an API key at once is the thing this project is for, so the
 * one row that says what it cost has to hold both.
 *
 * Only what a provider stated. A model priced from a table is neither of
 * these: nobody was billed, and it belongs to `costOf`.
 */
export function splitOf(usages: Usage[]): { charged?: number; listed?: number } {
  let charged: number | undefined
  let listed: number | undefined
  for (const usage of usages) {
    if (usage.chargedUsd !== undefined) charged = (charged ?? 0) + usage.chargedUsd
    if (usage.listedUsd !== undefined) listed = (listed ?? 0) + usage.listedUsd
  }
  return {
    ...(charged !== undefined ? { charged } : {}),
    ...(listed !== undefined ? { listed } : {}),
  }
}
