import type { Line } from './screens/session.tsx'

/**
 * What is worth interrupting you for.
 *
 * A team runs in panes you are not looking at, so anything that needs you —
 * or that you would want to know before the bill arrives — has to survive not
 * being watched. That is the whole job: a notice is something that happened
 * somewhere you were not.
 *
 * Deliberately short. A bell that rings for everything is a bell people learn
 * to ignore, and then it fails at the one thing it exists for.
 */

export type Notice = {
  id: number
  agentId: string
  /** How much it wants you: a question stops work, the rest merely happened. */
  weight: 'asking' | 'failed' | 'done' | 'note'
  text: string
  at: number
  /** Cleared when you have looked at the agent it belongs to. */
  seen: boolean
}

/** Line kinds that are worth a notice, and how loudly. */
const WEIGHT: Record<string, Notice['weight'] | undefined> = {
  error: 'failed',
  // A handoff, a compaction, a queue being dropped: things you did not ask for
  // and would want to know happened.
  note: 'note',
}

/**
 * Turns a line into a notice, or decides it is not worth one.
 *
 * What an agent says and what it runs are not notices: they are the work, and
 * the work is what the pane is for. Reading a pane you are looking at should
 * never also ring a bell.
 */
export function noticeFor(line: Line, id: number, at: number): Notice | undefined {
  const weight = WEIGHT[line.kind]
  if (!weight) return undefined

  return { id, agentId: line.agentId, weight, text: oneLine(line.text), at, seen: false }
}

/** A question an agent is waiting on, which outranks anything it has said. */
export function askingNotice(agentId: string, summary: string, id: number, at: number): Notice {
  return { id, agentId, weight: 'asking', text: oneLine(summary), at, seen: false }
}

/**
 * How many unseen notices each agent has, and how loud the loudest is.
 *
 * Per agent because that is where the mark goes — on the tab, so you can see
 * which pane wants you without opening any of them.
 */
export function unseenBy(
  notices: Notice[],
): Map<string, { count: number; weight: Notice['weight'] }> {
  const order: Notice['weight'][] = ['note', 'done', 'failed', 'asking']
  const by = new Map<string, { count: number; weight: Notice['weight'] }>()

  for (const notice of notices) {
    if (notice.seen) continue
    const held = by.get(notice.agentId)
    if (!held) {
      by.set(notice.agentId, { count: 1, weight: notice.weight })
      continue
    }
    held.count += 1
    if (order.indexOf(notice.weight) > order.indexOf(held.weight)) held.weight = notice.weight
  }

  return by
}

/**
 * Marks everything belonging to one agent as seen.
 *
 * Looking at a pane is what reading its notices means. Anything else — a key
 * to dismiss them, a list to tick off — asks you to tell the interface
 * something it can already see you doing.
 */
export function seeing(notices: Notice[], agentId: string): Notice[] {
  return notices.map((notice) => (notice.agentId === agentId ? { ...notice, seen: true } : notice))
}

/** The bell for the whole screen: what is unseen, anywhere. */
export function total(notices: Notice[]): number {
  return notices.filter((notice) => !notice.seen).length
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}
