/**
 * The canonical model. Nothing outside this file describes a provider's wire
 * format: every provider plugin translates between its own dialect and these
 * types, in both directions. Adding a provider must never require changing
 * anything here — if it does, the abstraction is wrong.
 */

export type Role = 'system' | 'user' | 'assistant'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  /**
   * A picture, carried as bytes rather than as a path.
   *
   * By value because an agent's worktree is not the directory the picture came
   * from, and a path that resolved when it was pasted may resolve to something
   * else, or nothing, by the time a provider is asked about it. Every model
   * that can see one takes base64 anyway.
   */
  | { type: 'image'; mediaType: ImageMediaType; data: string; alt?: string }

/**
 * What every provider that accepts pictures will accept.
 *
 * Deliberately short: a format one provider takes and another rejects turns a
 * canonical message into a message that only works on some of the team, which
 * is the one thing this model exists to prevent.
 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type Message = {
  role: Role
  content: ContentBlock[]
}

export type StopReason =
  /** The model finished its answer and expects the user to speak next. */
  | 'end_turn'
  /** The model wants one or more tools executed before it continues. */
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'

/**
 * What a turn consumed, and where anybody would say so, what it cost.
 *
 * The four counts are disjoint. A token that was served from a cache is
 * counted once, under the count that names the rate it was billed at, and
 * never again under `inputTokens` — every provider converts into that
 * convention, because the consumers add all four together. A dialect that
 * reports its cached tokens as a subset of its prompt total subtracts them
 * before reporting, or every long conversation is charged for its cache twice.
 */
export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Dollars a payment method was actually charged, where the provider said so. */
  chargedUsd?: number
  /**
   * Dollars of work drawn against something already bought — a plan, an
   * allowance, a grant — at the provider's own list price.
   *
   * Real money and not the same money. Adding it to what was charged invents a
   * bill; calling it zero deletes the only evidence the plan was worth buying.
   */
  listedUsd?: number
  /**
   * How many turns in this total spent tokens and said nothing about money.
   *
   * A provider that states what a turn cost is the thing being billed, so its
   * figure wins and the price table is not consulted at all. That is right
   * until the same agent has a turn that stated nothing: those tokens were
   * spent, and a figure built only from the turns that spoke prices them at
   * zero. This is how anything downstream can tell it is looking at half an
   * answer rather than a whole one.
   *
   * Absent when every turn spoke, and when none did — the ordinary case, an
   * agent on a plain endpoint, is untouched.
   */
  unstatedTurns?: number
}

/**
 * Every token a turn moved, cached halves included.
 *
 * Six places summed input and output and stopped, which on a turn that read
 * ten thousand tokens from a cache and wrote sixteen thousand more printed
 * "6 tokens". They are billed at different rates, which is why they are
 * counted apart — but a count of how much a turn moved is not a price, and
 * leaving them out is not a discount, it is a wrong number.
 */
export function tokensOf(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  )
}

/**
 * How much of one metered window a provider says has been used.
 *
 * Every service that limits how fast it may be asked has windows like these,
 * whether it sells a flat plan or bills per token, so this is not one vendor's
 * idea rendered into the model: a plain HTTP provider can fill it from the
 * rate-limit headers it already receives.
 */
export type MeterWindow = {
  /** Whatever the service calls it, passed through rather than judged. */
  name: string
  /**
   * How much of the window is gone, from 0 to 1.
   *
   * A fraction and never a percentage, because the two are indistinguishable
   * at a glance and a `0.02` read as a percentage prints "98% left" when 98%
   * happens to be right — which is exactly the kind of error that survives
   * review. Whatever renders it converts once, at its own edge.
   */
  usedFraction: number
  resetsAt: Date
}

/**
 * What a provider emits while streaming. Providers report increments; the core
 * accumulator is the only place that reassembles them into content blocks, so
 * a provider never has to buffer or track partial state itself.
 */
export type StreamDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  /** A fragment of the tool input, as raw JSON text. Providers stream this in
   *  arbitrary slices; only the concatenation is required to be valid JSON. */
  | { type: 'tool_use_delta'; id: string; partialInput: string }
  | { type: 'tool_use_end'; id: string }
  /**
   * How much of its allowance the provider says is left.
   *
   * Not part of the turn's content and not required to arrive at all: a
   * provider that never mentions its limits simply never sends one.
   */
  | { type: 'meter'; providerId: string; windows: MeterWindow[] }
  | { type: 'done'; stopReason: StopReason; usage: Usage }

/** One completed assistant turn, reassembled from a delta stream. */
export type AssistantTurn = {
  content: ContentBlock[]
  stopReason: StopReason
  usage: Usage
}

export type ToolDefinition = {
  name: string
  description: string
  /** JSON Schema for the arguments. Providers render this into their own shape. */
  inputSchema: Record<string, unknown>
}

export type CanonicalRequest = {
  model: string
  system: string
  messages: Message[]
  tools: ToolDefinition[]
  maxTokens: number
  temperature?: number
}

/**
 * An agent's running total.
 *
 * The cached halves are carried too. Dropped, an agent's total disagreed with
 * the same sum inside the loop — and since cost is worked out from these
 * numbers, a bill would have been quietly short by whatever the cache saved.
 */
export function addUsage(total: Usage, turn: Usage): Usage {
  const cacheRead = (total.cacheReadTokens ?? 0) + (turn.cacheReadTokens ?? 0)
  const cacheWrite = (total.cacheWriteTokens ?? 0) + (turn.cacheWriteTokens ?? 0)
  const charged = addMoney(total.chargedUsd, turn.chargedUsd)
  const listed = addMoney(total.listedUsd, turn.listedUsd)
  // Additive rather than a flag, because this merges whole agents into a task
  // total as well as turns into an agent's: counting one either way would say
  // a task of three silent agents had one silent turn.
  const silent =
    (total.unstatedTurns ?? 0) +
    (turn.unstatedTurns ?? (spentSomething(turn) && !statedMoney(turn) ? 1 : 0))

  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    // The two kinds of money stay apart. Folded together the total can no
    // longer say how much of itself was actually charged to anything.
    ...(charged !== undefined ? { chargedUsd: charged } : {}),
    ...(listed !== undefined ? { listedUsd: listed } : {}),
    ...(silent > 0 ? { unstatedTurns: silent } : {}),
  }
}

/** Whether this usage moved anything at all. */
function spentSomething(usage: Usage): boolean {
  return tokensOf(usage) > 0
}

/** Whether a provider said what this cost, in either kind of money. */
function statedMoney(usage: Usage): boolean {
  return usage.chargedUsd !== undefined || usage.listedUsd !== undefined
}

/**
 * Two figures added, where either may simply not exist.
 *
 * Not the `> 0` test the token counts use: a provider that says a turn cost
 * nothing has told us something, and dropping that leaves the turn looking
 * unpriced — which sends it back to a table to be guessed at.
 */
function addMoney(total: number | undefined, turn: number | undefined): number | undefined {
  if (total === undefined && turn === undefined) return undefined
  return (total ?? 0) + (turn ?? 0)
}
