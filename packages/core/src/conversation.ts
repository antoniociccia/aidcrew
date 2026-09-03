import type { ContentBlock, Message } from './types.ts'

/**
 * Keeping a conversation in a shape a provider will accept.
 *
 * Every dialect insists that a tool call is followed by its result, and says
 * so plainly when it is not: "No tool output found for function call
 * call_01a04d…". One unanswered call is enough, and from then on every turn
 * fails — the agent cannot say anything ever again, because the thing it
 * cannot get past is in its own history.
 *
 * A call ends up unanswered whenever a turn stops between making it and
 * running it: the escape key, a provider that dropped the connection, a
 * process that was killed. That used to be survivable by accident, since a
 * failed turn saved nothing at all. Now that what happened is always written
 * down, a broken conversation would be written down too — so it is closed
 * here instead, on the way in and on the way out.
 */

/** What a call that never ran is told to have returned. */
const NEVER_RAN = 'The turn stopped before this ran, so it produced no result.'

/**
 * Answers any tool call that has no result.
 *
 * The answer says what actually happened rather than inventing an outcome: a
 * model told a command succeeded when it never ran will build on something
 * that is not there, which is worse than being told plainly that it stopped.
 *
 * Results are added to the message that follows the call when that message is
 * already the user's, and as a new one otherwise — which is the shape every
 * dialect expects, and the shape the loop itself produces.
 */
export function closeOpenCalls(messages: Message[]): Message[] {
  const answered = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') answered.add(block.toolUseId)
    }
  }

  const out: Message[] = []

  for (const [at, message] of messages.entries()) {
    out.push(message)

    const open = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
        block.type === 'tool_use' && !answered.has(block.id),
    )
    if (open.length === 0) continue

    const missing: ContentBlock[] = open.map((call) => ({
      type: 'tool_result',
      toolUseId: call.id,
      content: NEVER_RAN,
      isError: true,
    }))

    const next = messages[at + 1]
    if (next?.role === 'user') {
      // Folded into the reply that follows, which is where results live.
      out.pop()
      out.push(message, { role: 'user', content: [...missing, ...next.content] })
      messages.splice(at + 1, 1, { role: 'user', content: [] })
      continue
    }

    out.push({ role: 'user', content: missing })
  }

  // The placeholder left behind by folding, which is nothing to send.
  return out.filter((message) => message.content.length > 0)
}

/** Whether every tool call in this conversation has been answered. */
export function isWellFormed(messages: Message[]): boolean {
  const answered = new Set<string>()
  const called: string[] = []

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') called.push(block.id)
      if (block.type === 'tool_result') answered.add(block.toolUseId)
    }
  }

  return called.every((id) => answered.has(id))
}
