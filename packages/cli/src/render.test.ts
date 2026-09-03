import { describe, expect, test } from 'bun:test'
import type { LoopEvent, TeamEvent } from '@aidcrew/core'
import { createRenderer, createTeamRenderer } from './render.ts'

function render(events: LoopEvent[], color = false): string {
  let out = ''
  const renderer = createRenderer({
    write: (text) => {
      out += text
    },
    color,
  })
  for (const event of events) renderer.handle(event)
  renderer.finish()
  return out
}

/** Matches the escape character that starts every ANSI sequence. */
const ANSI = new RegExp(String.fromCharCode(27))

describe('createRenderer', () => {
  test('streams assistant text as it arrives', () => {
    expect(
      render([
        { type: 'delta', delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'delta', delta: { type: 'text_delta', text: 'lo' } },
      ]),
    ).toContain('Hello')
  })

  test('does not print the model reasoning as if it were the answer', () => {
    const out = render([{ type: 'delta', delta: { type: 'thinking_delta', text: 'hmm' } }])

    expect(out).not.toContain('hmm')
  })

  test('shows each tool call on one line with its main argument', () => {
    const out = render([
      { type: 'tool_start', id: 't1', name: 'read', input: { path: 'src/a.ts' } },
    ])

    expect(out).toContain('read')
    expect(out).toContain('src/a.ts')
  })

  test('marks a failed tool call so it is not mistaken for a result', () => {
    const out = render([
      { type: 'tool_start', id: 't1', name: 'bash', input: { command: 'exit 1' } },
      {
        type: 'tool_end',
        id: 't1',
        name: 'bash',
        output: { content: 'command failed with exit code 1', isError: true },
        durationMs: 5,
      },
    ])

    expect(out).toMatch(/error|failed/i)
  })

  test('never prints the whole output of a tool', () => {
    const out = render([
      {
        type: 'tool_end',
        id: 't1',
        name: 'bash',
        output: { content: 'x'.repeat(5000) },
        durationMs: 5,
      },
    ])

    expect(out.length).toBeLessThan(500)
  })

  test('emits no ansi codes when colour is off', () => {
    const out = render([
      { type: 'tool_start', id: 't1', name: 'read', input: { path: 'a.ts' } },
      { type: 'delta', delta: { type: 'text_delta', text: 'hi' } },
    ])

    expect(out).not.toMatch(ANSI)
  })

  test('uses colour when the terminal supports it', () => {
    const out = render(
      [{ type: 'tool_start', id: 't1', name: 'read', input: { path: 'a.ts' } }],
      true,
    )

    expect(out).toMatch(ANSI)
  })

  test('separates a tool call from the text that preceded it', () => {
    const out = render([
      { type: 'delta', delta: { type: 'text_delta', text: 'Looking' } },
      { type: 'tool_start', id: 't1', name: 'read', input: { path: 'a.ts' } },
    ])

    expect(out).toMatch(/Looking\n/)
  })
})

/**
 * The headless run has nobody watching a pane, so what the interface would
 * have put in one has to be printed. These are the lines that say why a run
 * did not go as expected — the ones somebody reads in a CI log.
 */
describe('createTeamRenderer', () => {
  function renderTeam(events: TeamEvent[]): string {
    let out = ''
    const renderer = createTeamRenderer({
      write: (text) => {
        out += text
      },
      color: false,
    })
    for (const event of events) renderer.handle(event)
    renderer.finish()
    return out
  }

  test('says when a turn was cut short, and by what', () => {
    const out = renderTeam([
      { type: 'agent_cut_short', id: 'coder', reason: 'max_tokens', tool: 'write' },
    ])

    expect(out).toContain('coder')
    expect(out).toMatch(/ran out of room/)
    expect(out).toContain('write')
  })

  test('says when an agent was sent back past its turn limit', () => {
    const out = renderTeam([{ type: 'agent_continued', id: 'coder', round: 2, of: 4 }])

    expect(out).toMatch(/coder.*carry on.*2 of 4/)
  })

  test('says when a checkout was kept, and where', () => {
    const out = renderTeam([
      { type: 'workspace_kept', task: 'main', path: '/repo/.aidcrew/wt/main' },
    ])

    expect(out).toContain('/repo/.aidcrew/wt/main')
    expect(out).toMatch(/kept/)
  })

  test('says when an agent starts in a checkout the last run left work in', () => {
    const out = renderTeam([{ type: 'workspace_resumed', id: 'coder', task: 'main', changed: 3 }])

    expect(out).toMatch(/coder.*picked up.*3 files/)
  })
})
