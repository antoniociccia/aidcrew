import type { AgentSnapshot } from '@aidcrew/core'

/**
 * The one line that says what an agent is up to.
 *
 * It sits between the agent's name and its model, where a row of sparkline
 * blocks used to be. That row was mostly `▁` — an agent that has done nothing
 * has no history to draw — so it cost a row of the screen to say nothing. This
 * says the thing you actually want to know: what it is doing right now, or the
 * last thing it told you.
 */

export type Pulse = {
  text: string
  /** What the text is, which decides how it is coloured. */
  kind: 'working' | 'said' | 'quiet'
}

export type PulseLine = {
  kind: 'ask' | 'say' | 'tool' | 'error' | 'note' | 'thinking'
  text: string
}

export function pulseOf(agent: AgentSnapshot, lines: PulseLine[]): Pulse {
  if (agent.status === 'working') {
    // What is waiting comes first while it is running: three instructions and
    // one status reads exactly like three instructions and two of them lost.
    if (agent.queued > 0) {
      return { text: `${agent.queued} more waiting`, kind: 'working' }
    }
    // What it is doing beats what it last said: while it is running, the tool
    // in flight is the thing you are waiting on.
    const doing = lines.at(-1)
    if (doing && doing.kind !== 'say') return { text: oneLine(doing.text), kind: 'working' }
    return { text: 'thinking', kind: 'working' }
  }

  const failed = lines.at(-1)?.kind === 'error' ? lines.at(-1) : undefined
  if (failed) return { text: oneLine(failed.text), kind: 'said' }

  // What it said, not what it was asked: this row is for the agent's own
  // answer, and echoing the instruction back says nothing about its state.
  const said = [...lines].reverse().find((line) => line.kind === 'say')
  if (said) return { text: oneLine(said.text), kind: 'said' }

  return { text: agent.turns === 0 ? 'ready' : 'idle', kind: 'quiet' }
}

/**
 * A paragraph as a single line.
 *
 * This is a one-line summary by definition, and what it summarises arrives in
 * paragraphs. Left alone, the line break made the cell two rows tall and every
 * agent's column after it slid out of alignment.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A running line of text, revealed a character at a time.
 *
 * A spinner says only that something is happening. Letting the agent's own
 * words arrive across the row says what — and it is the same width either way,
 * so the header never reflows.
 */
export function marquee(text: string, width: number, frame: number): string {
  if (width <= 0) return ''
  const characters = [...text]
  if (characters.length <= width) return text

  // Holds still at each end for a beat, so the start and the end can be read
  // rather than swept past.
  const travel = characters.length - width
  const pause = 8
  const cycle = travel + pause * 2
  const at = frame % cycle
  const offset = Math.min(travel, Math.max(0, at - pause))

  return characters.slice(offset, offset + width).join('')
}
