import type { Message, Usage } from '@aidcrew/core'

/**
 * When a conversation has grown too long, and what to do about it.
 *
 * The hard part is knowing *when*. Nothing tells a harness how much room a
 * model has left: providers report what a request cost after it is sent, and
 * the limit itself is a property of the model that changes between releases
 * and is not in any response. Estimating from the text is worse — tokenisers
 * differ per model, and an estimate that is wrong in the safe direction
 * compacts a conversation that did not need it.
 *
 * So the measure used here is the one true number available: what the last
 * turn actually cost to send, as the provider counted it. It lags by exactly
 * one turn, which is the price of not guessing, and one turn of headroom is
 * what the budget is for.
 */

export type Budget = {
  /**
   * Input tokens past which the next turn is compacted first.
   *
   * A budget rather than a limit: it is set below what the model can take, so
   * there is room for the turn that discovers the conversation is too long.
   */
  compactAt: number
  /**
   * How many of the most recent messages survive untouched.
   *
   * The end of a conversation is what the model is reasoning from — the file
   * it just read, the error it just saw — and summarising that is how an agent
   * loses the thread it was holding.
   */
  keep: number
}

/**
 * Sixty thousand input tokens, and the last twelve messages.
 *
 * It was twice this, which was wrong twice over. A model with a 128k window
 * that has already sent 120k has no room left to answer in — the turn that
 * discovers the conversation is too long is the turn that fails. And a weaker
 * model asks for one thing at a time as its context grows: fifteen reads in a
 * single turn early in a session, one read per turn by the end, with the whole
 * conversation sent again each time. Keeping it shorter is what keeps it
 * asking for things in groups.
 *
 * Per agent in the project config when a particular one wants otherwise.
 */
export const DEFAULT_BUDGET: Budget = { compactAt: 60_000, keep: 12 }

export type Plan =
  | { compact: false; because: string }
  | { compact: true; summarise: Message[]; keep: Message[] }

/**
 * Decides whether this turn should shorten the conversation, and what of it.
 *
 * Only whole user-to-assistant exchanges are summarised. Cutting between a
 * tool call and its result leaves a call nothing answered, which providers
 * reject outright — and the ones that do not, answer strangely.
 */
export function plan(messages: Message[], lastUsage: Usage, budget: Budget): Plan {
  // What was read from a cache counts. It is a token the model saw, reported
  // apart from the rest because it is billed at a tenth of the rate — and this
  // decision is not about money, it is about whether the conversation still
  // fits. Reading only the uncached part makes a heavily cached conversation
  // look small and never shortens it, which is exactly the long conversation
  // caching produces.
  const prompt = lastUsage.inputTokens + (lastUsage.cacheReadTokens ?? 0)
  if (prompt < budget.compactAt) {
    return { compact: false, because: 'it still fits' }
  }
  if (messages.length <= budget.keep) {
    return { compact: false, because: 'there is nothing old enough to summarise' }
  }

  const at = boundaryBefore(messages, messages.length - budget.keep)
  if (at <= 0) {
    return { compact: false, because: 'no exchange ends early enough to cut at' }
  }

  return { compact: true, summarise: messages.slice(0, at), keep: messages.slice(at) }
}

/**
 * The latest safe place to cut at or before `at`.
 *
 * Safe means: everything before it is complete. A tool call in the summarised
 * part whose result is in the kept part would leave the model holding an
 * answer to a question it can no longer see.
 */
function boundaryBefore(messages: Message[], at: number): number {
  for (let index = Math.min(at, messages.length); index > 0; index--) {
    if (endsCleanly(messages, index)) return index
  }
  return 0
}

function endsCleanly(messages: Message[], index: number): boolean {
  const calls = new Set<string>()

  for (const message of messages.slice(0, index)) {
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.add(block.id)
      if (block.type === 'tool_result') calls.delete(block.toolUseId)
    }
  }

  // Nothing asked for and left unanswered, and the next message starts a turn
  // rather than continuing one.
  return calls.size === 0 && messages[index]?.role === 'user'
}

/** What the summary is asked for, and what it must not leave out. */
export const BRIEF = `Summarise the conversation above so that it can be
continued without it.

Keep: what was being built and why, decisions taken and the reasons for them,
anything tried that did not work, file paths and names that came up, and
anything the user asked for that has not been done yet.

Drop: the contents of files, command output, and anything already superseded.

Write it as notes to yourself, not as a report to somebody else. Be specific:
"the refresh token was not rotated in guard.ts" is useful, "we fixed a bug" is
not.`

/** How the summary re-enters the conversation. */
export function asMessage(summary: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        // Said plainly rather than smuggled in as though the model had thought
        // it: an agent that cannot tell its notes from its memory will defend
        // a summary it never wrote.
        text: `[Earlier in this conversation, summarised because it grew too long to send in full]\n\n${summary}`,
      },
    ],
  }
}
