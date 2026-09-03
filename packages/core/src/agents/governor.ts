import type { Usage } from '../types.ts'

/** A message passed from one agent to another. */
export type AgentMessage = {
  from: string
  to: string
  text: string
  /** How many agents this message has already been through. */
  hops: number
  /**
   * Whether this is an answer to something the recipient handed over.
   *
   * A reply is not new work. Asked about like new work it interrupts the
   * person with a choice they have no reason to make — start a second agent
   * to receive an answer? — so a reply waits its turn instead of asking.
   */
  reply?: boolean
  /**
   * The agent the person spoke to, which this chain reports back to.
   *
   * Answering whoever asked unwinds a chain a link at a time, and that is the
   * wrong shape: with architect → coder → tester the architect hears from the
   * coder rather than from the tester, so it learns the work is written before
   * anyone has learned it passes — and merging, the last thing it has to do,
   * is then the thing it does too early. Whoever was handed the job owns it,
   * so the far end of the chain reports to them.
   */
  origin?: string
  /**
   * How many times the harness has already told the recipient to carry on
   * with this, after its turn reached the limit. Absent for a first turn.
   */
  continued?: number
}

/**
 * How far one instruction may travel before somebody is asked again.
 *
 * A backstop against a relay nobody stops, and not the spend control — the
 * token budgets below are, and say so. It was four, which is fewer than one
 * pipeline: three agents passing a job along, three jobs, is nine handoffs
 * from one thing somebody typed, and the count only starts over when a person
 * speaks. That was refused on the fourth and blamed on the agents.
 *
 * Every handoff also costs a turn, and `maxTurnsPerAgent` bounds those, so a
 * genuine runaway is already caught by something that knows what it is
 * counting. This just has to be above any real chain.
 */
export const DEFAULT_MAX_HOPS = 32

/**
 * What an agent may spend, and how far it may go, with the brake on the right
 * one of the two.
 *
 * The turn count used to be the only limit, and a turn is not a unit of money:
 * one can cost two hundred tokens or thirty thousand. Measured on a real job,
 * an agent spent 2,028,174 tokens writing one plugin — the same conversation
 * sent back fifty times, because the service it was on caches nothing — and
 * what stopped it was running out of turns, at the end, with the work nearly
 * done. It was the wrong thing counted, and it was counted too low.
 *
 * There is no default ceiling on the tokens, though. One was tried, at three
 * million, and it stopped a runaway and a large honest job with the same cut:
 * on a service that caches nothing the whole conversation is re-sent every
 * turn, and a real feature crossed that line while it was still working. That
 * is the failure the limit exists to prevent, paid for in thrown-away work
 * instead of saved money. So the token budget is opt-in — a project that wants
 * one sets `maxTokensPerAgent`, and it is honoured, and cached tokens count
 * toward it — and the turn count stays as the backstop a loop cannot outlast.
 */
export const DEFAULT_LIMITS: Limits = {
  maxHops: DEFAULT_MAX_HOPS,
  maxMessagesPerTurn: 3,
  maxTurnsPerAgent: 200,
}

export type Limits = {
  /** How far a message may travel before it is dropped. */
  maxHops: number
  maxTokensPerAgent?: number
  maxTotalTokens?: number
  maxTurnsPerAgent?: number
  /**
   * How many messages an agent may send in a single turn. Hops bound how far a
   * conversation travels; this bounds how wide it gets, which is a different
   * runaway: one agent can flood the team without any chain being long.
   *
   * Messages the agent sends and that arrive. The closing reply the harness
   * writes on its behalf is not one of them, and neither is an attempt that
   * delivered nothing.
   */
  maxMessagesPerTurn?: number
}

export type Verdict = { ok: true } | { ok: false; reason: string }

const ALLOWED: Verdict = { ok: true }

/**
 * The three limits that make a team of agents predictable.
 *
 * A mailbox system has one characteristic failure: two agents answer each
 * other, politely and forever, and nobody notices until the bill arrives.
 * Hop counts stop that. Per-agent and session budgets stop the slower version
 * of the same thing, where five agents each do reasonable work and together
 * spend a fortune.
 *
 * Every limit is optional except hops. Absent means unlimited, which is a
 * choice the user makes rather than a default they stumble into.
 */
export class Governor {
  readonly #limits: Limits
  readonly #spent = new Map<string, number>()
  readonly #turns = new Map<string, number>()
  readonly #sentThisTurn = new Map<string, number>()

  constructor(limits: Limits) {
    this.#limits = limits
  }

  allowDelivery(message: AgentMessage): Verdict {
    if (message.from === message.to) {
      return { ok: false, reason: `agent "${message.from}" cannot send messages to itself` }
    }
    if (message.hops >= this.#limits.maxHops) {
      // Not "talking in circles". This counts how far a message has travelled
      // from the person who started it, not whether it has been anywhere
      // twice, and a pipeline looks exactly like a loop to a counter: three
      // agents passing one job along three times is nine hops of honest
      // progress. Saying they are looping sends somebody hunting a bug that
      // is not there, and what they actually need is the number.
      return {
        ok: false,
        reason:
          `message dropped after ${message.hops} handoffs without anybody being asked. ` +
          'Say something to one of them to start the count over, or raise maxHops.',
      }
    }
    return ALLOWED
  }

  /**
   * Whether an agent may take another turn.
   *
   * `from` matters for one of the three limits. The turn count exists to stop
   * two agents answering each other forever, and it has no business stopping
   * the person: past it, everything typed was dropped in silence. The token
   * budgets are not like that — they are a decision about money, and money
   * spent on somebody's own instruction is spent just the same.
   */
  allowTurn(agentId: string, from: 'user' | 'agent' = 'agent'): Verdict {
    const { maxTokensPerAgent, maxTotalTokens, maxTurnsPerAgent } = this.#limits

    if (maxTokensPerAgent !== undefined && this.spentBy(agentId) >= maxTokensPerAgent) {
      return {
        ok: false,
        reason: `agent "${agentId}" has spent its budget of ${maxTokensPerAgent} tokens`,
      }
    }
    if (maxTotalTokens !== undefined && this.spentTotal() >= maxTotalTokens) {
      return { ok: false, reason: `the session budget of ${maxTotalTokens} tokens is spent` }
    }
    if (
      from !== 'user' &&
      maxTurnsPerAgent !== undefined &&
      (this.#turns.get(agentId) ?? 0) >= maxTurnsPerAgent
    ) {
      return {
        ok: false,
        reason: `agent "${agentId}" reached its limit of ${maxTurnsPerAgent} turns`,
      }
    }

    return ALLOWED
  }

  /**
   * Adds one turn's spending to what an agent has spent.
   *
   * Named for what it does to the total, because the argument is a delta and
   * the method adds it: handed a running total instead, this charges the whole
   * session again on every turn, and the budget is spent in a fraction of the
   * turns it was meant to buy. That is not hypothetical — it is the bug this
   * name exists to stop coming back.
   *
   * Cache reads count: they are cheaper than fresh input, but they are billed.
   */
  charge(agentId: string, spentThisTurn: Usage): void {
    const cost =
      spentThisTurn.inputTokens +
      spentThisTurn.outputTokens +
      (spentThisTurn.cacheReadTokens ?? 0) +
      (spentThisTurn.cacheWriteTokens ?? 0)

    this.#spent.set(agentId, this.spentBy(agentId) + cost)
  }

  /** Called when an agent starts a turn, so its send allowance is fresh. */
  beginTurn(agentId: string): void {
    this.#sentThisTurn.set(agentId, 0)
  }

  /**
   * Whether an agent may send one more message this turn.
   *
   * Checks without counting: `recordSend` counts, once the message is in a
   * mailbox. The two were one call, so a send that delivered nothing — a
   * name that matched nobody, a recipient being stopped, a message the
   * person chose to drop — still cost one of the allowance, and the corrected
   * attempt after a typo could be the one refused.
   */
  allowSend(agentId: string): Verdict {
    const limit = this.#limits.maxMessagesPerTurn
    const sent = this.#sentThisTurn.get(agentId) ?? 0

    if (limit !== undefined && sent >= limit) {
      return {
        ok: false,
        reason: `agent "${agentId}" already sent ${sent} messages this turn`,
      }
    }

    return ALLOWED
  }

  /** Counts one message that was actually delivered. */
  recordSend(agentId: string): void {
    this.#sentThisTurn.set(agentId, (this.#sentThisTurn.get(agentId) ?? 0) + 1)
  }

  recordTurn(agentId: string): void {
    this.#turns.set(agentId, (this.#turns.get(agentId) ?? 0) + 1)
  }

  spentBy(agentId: string): number {
    return this.#spent.get(agentId) ?? 0
  }

  spentTotal(): number {
    let total = 0
    for (const spent of this.#spent.values()) total += spent
    return total
  }
}
