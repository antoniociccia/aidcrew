import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { GRAPHITE } from '../theme.ts'
import type { SessionNotice } from './notice.tsx'
import { NoticeBox } from './notice.tsx'

/** Everything Ink wrote, which is what the reader would have seen. */
function drawn(notice: SessionNotice): string {
  const written: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      written.push(chunk)
      return true
    },
    columns: 80,
    rows: 24,
    isTTY: true,
  })

  const app = render(<NoticeBox notice={notice} theme={GRAPHITE} width={80} />, {
    stdout: stdout as never,
    patchConsole: false,
  })
  app.unmount()
  // Without the escapes, which are how the colour got there and not what
  // anybody reads.
  // Every escape, not only the colours: the cursor codes are how it got
  // drawn and not what anybody reads.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
  return written.join('').replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '')
}

const stalled: SessionNotice = {
  title: 'nobody is working, and one handoff has no answer',
  detail: [
    'architect → plugin-writer, 4 minutes ago',
    'its turn ran out of room before it answered — the write it had started never ran',
  ],
  keys: [['↵', 'tell plugin-writer to carry on']],
  tone: 'ask',
}

describe('a notice that belongs to the session rather than to an agent', () => {
  test('says the thing, what is known about it, and what to do', () => {
    // All three, because "nothing is happening" is something the user could
    // already see. What makes it worth interrupting for is who was waiting on
    // whom and how the turn ended.
    const frame = drawn(stalled)

    expect(frame).toContain('nobody is working')
    expect(frame).toContain('architect → plugin-writer')
    expect(frame).toContain('never ran')
  })

  test('says what would end it', () => {
    // Drawn only while nothing is happening, so there is nothing to dismiss.
    // What it owes the reader is the next move.
    expect(drawn(stalled)).toContain('tell plugin-writer to carry on')
  })

  test('does not reach the edge of the screen', () => {
    // Inset, so it reads as being over the session rather than as being it.
    for (const line of drawn(stalled).split('\n')) {
      expect(line.length).toBeLessThan(80)
    }
  })
})
