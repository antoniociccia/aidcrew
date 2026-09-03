import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { AgentSnapshot } from '@aidcrew/core'
import { render } from 'ink'
import { widthOf } from '../components/text-width.ts'
import { GRAPHITE, GUTTER } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import type { Pending, SessionProps } from './session.tsx'
import { askedBefore, Session } from './session.tsx'

/**
 * The mouse, end to end.
 *
 * A click is only useful if it reaches the right agent, and the arithmetic
 * that decides which agent is the same arithmetic that draws them. These press
 * the terminal's own escape sequences into stdin and check what came out the
 * other side — the one thing that cannot be verified by reading the code.
 */

const agent = (id: string, usage = { inputTokens: 0, outputTokens: 0 }): AgentSnapshot => ({
  id,
  model: 'muse-spark-1.2',
  status: 'idle',
  usage,
  turns: 0,
  workspace: `/repo/.aidcrew/wt/${id}`,
  isolated: true,
  yolo: false,
  queued: 0,
  behind: 0,
  activity: [],
})

const COLUMNS = 100
const ROWS = 30

/** One turn of the loop. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

/** What was drawn, with the escapes that coloured and moved it taken out. */
function printable(written: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
  return written.replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '').trim()
}

/**
 * Waits for something to become true rather than for a length of time.
 *
 * Ink flushes input on a timer of its own and React renders later still, so a
 * fixed sleep decides whether the suite passes by how fast the machine is.
 */
/** Every background colour a frame paints, in order. */
function grounds(frame: string): string[] {
  return [...frame.matchAll(/48;2;(\d+;\d+;\d+)/g)].map((match) => match[1] as string)
}

async function waitFor(condition: () => boolean, what: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return
    await tick()
  }
  throw new Error(`waited for ${what} and it never happened`)
}

const settle = tick

/** What the terminal sends for a left press at a one-based coordinate. */
const press = (column: number, row: number, code = 0, ending = 'M'): string =>
  `\u001b[<${code};${column};${row}${ending}`

async function mount(
  over: {
    split?: string[]
    pending?: Pending
    spent?: AgentSnapshot['usage']
    /** An agent turned loose, to see what the tab does about it. */
    loose?: string
    files?: string[]
    extras?: SessionProps['extras']
    /** Commits the worktrees are behind, for the mark that says so. */
    behind?: number
    totalCost?: SessionProps['totalCost']
    notice?: SessionProps['notice']
    onPlan?: SessionProps['onPlan']
    waitingOn?: SessionProps['waitingOn']
    lines?: SessionProps['lines']
    onCancel?: SessionProps['onCancel']
    onCopy?: SessionProps['onCopy']
    /** Which agent is being typed at, when it is not the coder. */
    target?: string
  } = {},
) {
  // Ink 7 pulls from stdin with `readable` and `read()`, so a stub that only
  // emits `data` delivers nothing and every keyboard test passes vacuously.
  let queued: string | undefined
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    read: () => {
      const chunk = queued
      queued = undefined
      return chunk ?? null
    },
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  })

  const type = (data: string): void => {
    queued = data
    stdin.emit('readable')
  }

  const frames: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      frames.push(chunk)
      return true
    },
    columns: COLUMNS,
    rows: ROWS,
    isTTY: true,
  })

  const targeted: string[] = []
  const sent: string[] = []
  const opened = { agents: 0, settings: 0, workspaces: 0 }
  const agents = [
    agent('architect', over.spent),
    agent('coder', over.spent),
    agent('reviewer', over.spent),
  ]
    .map((snapshot) => (snapshot.id === over.loose ? { ...snapshot, yolo: true } : snapshot))
    .map((snapshot) => (over.behind ? { ...snapshot, behind: over.behind } : snapshot))

  const app = render(
    <ThemeProvider value={GRAPHITE}>
      <Session
        workspace="repo"
        agents={agents}
        lines={over.lines ?? []}
        target={over.target ?? 'coder'}
        rows={ROWS}
        columns={COLUMNS}
        {...(over.onCancel ? { onCancel: over.onCancel } : {})}
        {...(over.onCopy ? { onCopy: over.onCopy } : {})}
        {...(over.split ? { initialSplit: over.split } : {})}
        {...(over.pending ? { pending: over.pending } : {})}
        {...(over.files ? { files: over.files } : {})}
        {...(over.extras ? { extras: over.extras } : {})}
        {...(over.totalCost ? { totalCost: over.totalCost } : {})}
        {...(over.notice ? { notice: over.notice } : {})}
        {...(over.onPlan ? { onPlan: over.onPlan } : {})}
        {...(over.waitingOn ? { waitingOn: over.waitingOn } : {})}
        onTarget={(id) => targeted.push(id)}
        onSend={(text) => sent.push(text)}
        onOpenSettings={() => {
          opened.settings++
        }}
        onOpenAgents={() => {
          opened.agents++
        }}
        onSwitchWorkspace={() => {
          opened.workspaces++
        }}
        onQuit={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as never, stdout: stdout as never, patchConsole: false },
  )

  // Waited for rather than slept through. Ink flushes on a timer of its own
  // and React renders later still, so a fixed five milliseconds decides
  // whether these pass by how fast the machine is — and on a runner with no
  // terminal attached the first frame had not been written yet, so every one
  // of them read an empty screen and failed on something that was there.
  await waitFor(() => printable(frames.join('')) !== '', 'the first frame')

  return {
    targeted,
    sent,
    opened,
    frames,
    /**
     * Clicks at a screen position counted from zero, the way the interface
     * counts. The escape sequence a terminal sends counts from one, and
     * conflating the two put earlier tests one row off what they described.
     */
    click: async (column: number, row: number) => {
      type(press(column + 1, row + 1))
      await settle()
      type(press(column + 1, row + 1, 0, 'm'))
      await settle()
    },
    send: async (data: string) => {
      type(data)
      await settle()
    },
    frame: () => frames.join(''),
    /**
     * Whether `text` was written more recently than `after`.
     *
     * `frame()` is everything ever written, which answers "did this appear"
     * and not "is this on screen now" — and the last write is a delta rather
     * than a whole frame, so it cannot be read on its own either. What can be
     * asked reliably is which of two things came last.
     */
    since: (text: string, after: string) => {
      const whole = frames.join('')
      return whole.lastIndexOf(text) > whole.lastIndexOf(after)
    },
    unmount: () => app.unmount(),
  }
}

describe('clicking the team', () => {
  test('a click on a tab moves the focus to that agent', async () => {
    const ui = await mount()

    // Three agents across a hundred columns: the third tab starts at 66.
    await ui.click(70, 0)
    await waitFor(() => ui.targeted.length > 0, 'the focus to move')

    expect(ui.targeted).toEqual(['reviewer'])
    ui.unmount()
  })

  test('a click on the first tab picks the first agent', async () => {
    const ui = await mount()

    await ui.click(4, 0)
    await waitFor(() => ui.targeted.length > 0, 'the focus to move')

    expect(ui.targeted).toEqual(['architect'])
    ui.unmount()
  })

  test('every row of a tab selects it, not just the last one', async () => {
    // Only the bottom row used to work — a leftover from when the top rows
    // were the wordmark — so clicking a tab mostly did nothing at all.
    // The tabs are two rows deep; the one after them is the rule.
    for (const row of [0, 1]) {
      const ui = await mount()
      await ui.click(70, row)
      await waitFor(() => ui.targeted.length > 0, `row ${row} to select an agent`)

      expect(ui.targeted).toEqual(['reviewer'])
      ui.unmount()
    }
  })

  test('the rule under the tabs is not a tab', async () => {
    const ui = await mount()

    await ui.click(70, 2)
    ui.unmount()

    expect(ui.targeted).toEqual([])
  })
})

describe('clicking a pane', () => {
  test('a click in a column moves the focus to the agent shown there', async () => {
    const ui = await mount({ split: ['architect', 'coder'] })

    // Side by side, the left half is the first of the two.
    await ui.click(10, 9)
    await waitFor(() => ui.targeted.length > 0, 'the focus to move')

    expect(ui.targeted).toEqual(['architect'])
    ui.unmount()
  })

  test('a click in the other column picks the other agent', async () => {
    const ui = await mount({ split: ['architect', 'coder'] })

    await ui.click(80, 9)
    await waitFor(() => ui.targeted.length > 0, 'the focus to move')

    expect(ui.targeted).toEqual(['coder'])
    ui.unmount()
  })

  test('pressing on the rule between panes starts a drag, not a focus change', async () => {
    const ui = await mount({ split: ['architect', 'coder'] })

    await ui.send(press(51, 11))
    ui.unmount()

    expect(ui.targeted).toEqual([])
  })
})

describe('keeping the mouse out of the typing', () => {
  test('mouse reporting is never typed into the prompt', async () => {
    const sent: string[] = []
    const ui = await mount()

    await ui.send(press(10, 10))
    ui.unmount()

    // Nothing was submitted, and nothing crashed: the sequences were consumed
    // as mouse events rather than appended to a draft.
    expect(sent).toEqual([])
  })
})

describe('opening the split picker', () => {
  test('does not fall over, however many times it is opened and closed', async () => {
    // ^L used to skip a hook on the render that showed the picker, which
    // changed the order React saw and tore the interface apart.
    const ui = await mount()

    await ui.send('\u000c')
    await ui.send('\u001b')
    await ui.send('\u000c')
    await waitFor(() => ui.frame().includes('side by side'), 'the picker to reappear')

    ui.unmount()

    ui.unmount()
  })

  test('shows the picker rather than the session', async () => {
    const ui = await mount()

    await ui.send('\u000c')
    await waitFor(() => ui.frame().includes('side by side'), 'the picker to appear')

    ui.unmount()
  })
})

describe('typing while clicking', () => {
  test('a click never leaves its escape sequence in the draft', async () => {
    const ui = await mount()

    await ui.send('run')
    await ui.click(70, 0)
    await ui.send('!')
    await waitFor(() => ui.frame().includes('run!'), 'the typed text to appear')

    expect(ui.frame()).not.toContain('[<0;')
    ui.unmount()
  })
})

describe('what a tab says about an agent', () => {
  test('shows the model, then what it has spent, and back', async () => {
    const ui = await mount({ spent: { inputTokens: 12_400, outputTokens: 3100 } })
    await waitFor(() => ui.frame().includes('coder'), 'the tabs to draw')

    // Four seconds each way. The wait is real time because the alternation is
    // the behaviour: a badge that never changes is the bug this replaced.
    expect(ui.frame()).toContain('muse-spark')
    await waitFor(() => ui.frame().includes('↑'), 'the tab to turn over', 1200)

    const spending = ui.frame()
    // Both halves: input grows on its own as the conversation is resent,
    // output is what the model actually wrote, and one total hides which of
    // the two is running away.
    expect(spending).toContain('↓')

    await waitFor(() => ui.frame().includes('muse-spark'), 'the model to come back', 1200)
    ui.unmount()
  }, 20_000)
})

describe('an agent acting without being asked', () => {
  test('takes over its whole tab, and is counted in the tray', async () => {
    // The small bolt this replaced was correct and easy to miss, and the one
    // thing you must not miss is which agent is running unsupervised — you
    // find out otherwise from what it did.
    const ui = await mount({ loose: 'coder' })
    await waitFor(() => ui.frame().includes('UNLEASHED'), 'the tab to say so')

    const loud = ui.frame()
    expect(loud).toContain('1 unleashed')
    // The word is a stamp set against the tab, not more of the tab's own
    // writing: it carries a ground of its own, which the cell must not paint
    // over. It did, and the word was invisible as anything but text.
    const stamp = loud.slice(loud.indexOf('UNLEASHED') - 40, loud.indexOf('UNLEASHED'))
    expect(stamp).toContain('48;2;30;30;35')
    ui.unmount()

    // Still its own colour — whose work this is has to stay readable — but a
    // different shade of it, so the column reads as changed at a glance.
    const quiet = await mount()
    await waitFor(() => quiet.frame().includes('coder'), 'the tabs to draw')
    expect(grounds(loud)).not.toEqual(grounds(quiet.frame()))
    quiet.unmount()
  })

  test('says nothing at all when every agent is supervised', async () => {
    const ui = await mount()
    await waitFor(() => ui.frame().includes('coder'), 'the tabs to draw')

    expect(ui.frame()).not.toContain('unleashed')
    ui.unmount()
  })
})

describe('copying text out of a pane', () => {
  test('hands the mouse back, and says how to take it again', async () => {
    // A terminal reporting the mouse gives every drag to the program, so
    // selecting text does nothing at all. There is no way to have both.
    const ui = await mount()
    await waitFor(() => ui.frame().includes('coder'), 'the panes to draw')

    await ui.send('\u0010')
    await waitFor(() => ui.frame().includes('mouse back on'), 'the tray to say it is off')

    // Reporting is switched off at the terminal, not merely ignored: the
    // terminal is the thing that has to stop intercepting the drag. This is
    // the fallback — holding option while dragging works with the mouse
    // still on, which is what the tray offers first.
    expect(ui.frame()).toContain('\u001b[?1000l')
    ui.unmount()
  })
})

describe('what a plugin adds to the interface', () => {
  test('reaches the tray and the tab it belongs to', async () => {
    const ui = await mount({
      extras: ({ slot, agent }) =>
        slot === 'tray'
          ? [{ text: '  on main', color: '#888' }]
          : agent?.id === 'coder'
            ? [{ text: ' ●', color: '#f00' }]
            : [],
    })
    await waitFor(() => ui.frame().includes('on main'), 'the tray addition')

    // In the tab of the agent it was asked about, and not in the others.
    const tabs = ui.frame().split('\n')[0] ?? ''
    expect(tabs).toContain('●')
    expect(tabs.split('●')).toHaveLength(2)

    ui.unmount()
  })
})

describe('side by side, where there are no tabs', () => {
  test('the pane title says everything a tab would have', async () => {
    // Splitting the screen used to lose the model, the spending, how far
    // behind the repository an agent is, and whether it is unsupervised —
    // all of which live on a tab, and there are no tabs here. There is room:
    // a pane is four times the width of a tab.
    const ui = await mount({
      split: ['architect', 'coder'],
      spent: { inputTokens: 8300, outputTokens: 2700 },
      loose: 'coder',
    })
    await waitFor(() => ui.frame().includes('UNLEASHED'), 'the titles to draw')

    const titles = ui.frame().split('\n')[0] ?? ''
    expect(titles).toContain('muse-spark')
    expect(titles).toContain('↑8.3k')
    expect(titles).toContain('↓2.7k')
    ui.unmount()
  })

  test('shows how far behind the repository a pane has fallen', async () => {
    const ui = await mount({ split: ['architect', 'coder'], behind: 3 })
    await waitFor(() => ui.frame().includes('↓3'), 'the count to appear')

    ui.unmount()
  })
})

describe('naming a file without typing @', () => {
  test('finds it by part of its name and puts it in the message', async () => {
    // The other way to name a file, and on some keyboards the only way: `@`
    // needs the option key on an Italian layout, and a terminal set to treat
    // that key as meta will not produce the character at all.
    const ui = await mount({ files: ['src/auth/guard.ts', 'docs/plan.md', 'README.md'] })
    await waitFor(() => ui.frame().includes('coder'), 'the panes to draw')

    await ui.send('\u0014')
    await waitFor(() => ui.frame().includes('find a file'), 'the finder to open')

    await ui.send('guard')
    await waitFor(() => ui.since('1 of 3', '3 of 3'), 'the search to narrow')
    // The list now holds the one match and not the others.
    expect(ui.since('src/auth/guard.ts', 'README.md')).toBe(true)

    await ui.send('\r')
    await waitFor(() => ui.frame().includes('@src/auth/guard.ts'), 'the name to reach the field')

    ui.unmount()
  })

  test('esc goes back without naming anything', async () => {
    const ui = await mount({ files: ['a.ts'] })
    await waitFor(() => ui.frame().includes('coder'), 'the panes to draw')

    await ui.send('\u0014')
    await waitFor(() => ui.frame().includes('find a file'), 'the finder to open')
    await ui.send('\u001b')
    // Settled rather than waited on a marker. This used to wait for the
    // field's placeholder to be drawn again, and the field no longer has one:
    // an empty field with a cursor is already an invitation, and a sentence
    // telling you to write holds the row all session to be read once. There
    // is nothing new on screen after escape, which is the point of escape.
    for (let beat = 0; beat < 8; beat++) await settle()

    expect(ui.frame()).not.toContain('@a.ts')
    ui.unmount()
  })
})

describe('typing a command', () => {
  test('shows what a slash could become, and what it takes', async () => {
    const ui = await mount()
    await waitFor(() => ui.frame().includes('coder'), 'the panes to draw')

    await ui.send('/sp')
    await waitFor(() => ui.frame().includes('/spawn'), 'the suggestions to appear')

    const frame = ui.frame()
    expect(frame).toContain('/split')
    // The shape of the first one, before it is typed wrong.
    expect(frame).toContain('<role>')

    ui.unmount()
  })

  test('naming a file with @ offers the files, not the commands', async () => {
    const ui = await mount({ files: ['src/auth.test.ts', 'docs/auth.md', 'README.md'] })
    await waitFor(() => ui.frame().includes('coder'), 'the panes to draw')

    await ui.send('look at @auth')
    await waitFor(() => ui.frame().includes('src/auth.test.ts'), 'the files to appear')

    expect(ui.frame()).toContain('docs/auth.md')
    expect(ui.frame()).not.toContain('README.md')
    ui.unmount()
  })

  test('an ordinary message brings no suggestions with it', async () => {
    const ui = await mount()
    await waitFor(() => ui.frame().includes('coder'), 'the panes to draw')

    await ui.send('fix the auth bug')
    await waitFor(() => ui.frame().includes('fix the auth bug'), 'the text to appear')

    expect(ui.frame()).not.toContain('/spawn')
    ui.unmount()
  })
})

describe('while an agent is waiting on a decision', () => {
  /**
   * The shortcuts used to be switched off entirely, and the question is only
   * drawn in the pane of the agent that asked it. An agent asking while you
   * looked at another one gave a screen with no question on it and no working
   * keys — a deadlock that read as the interface having died.
   */
  const waiting: Pending = {
    agentId: 'reviewer',
    because: 'runs a command',
    summary: 'rm -rf build',
    answers: [
      { key: 'y', label: 'once', tone: 'ok', take: () => {} },
      { key: 'n', label: 'refuse', tone: 'bad', take: () => {} },
    ],
    safe: 'n',
  }

  test('the keys still work', async () => {
    const ui = await mount({ pending: waiting })

    await ui.send('\u0005')
    await waitFor(() => ui.opened.agents > 0, 'the team editor to open')

    ui.unmount()
  })

  test('a busy recipient is asked about in the pane it belongs to', async () => {
    const taken: string[] = []
    const busy: Pending = {
      agentId: 'coder',
      because: 'is busy, and architect sent work',
      summary: 'have a look at PLAN.md',
      answers: [
        { key: 'w', label: 'wait', tone: 'ok', take: () => taken.push('wait') },
        { key: 's', label: 'spawn a second coder', tone: 'warn', take: () => taken.push('spawn') },
        { key: 'd', label: 'drop it', tone: 'bad', take: () => taken.push('drop') },
      ],
      safe: 'w',
    }
    const ui = await mount({ pending: busy })
    await waitFor(() => ui.frame().includes('spawn a second'), 'the question to draw')

    // The choice says what it will cost before it is made: a second agent is
    // a second bill, and that is the part worth knowing in advance.
    expect(ui.frame()).toContain('is busy')

    await ui.send('s')
    await waitFor(() => taken.length > 0, 'the answer to be taken')
    expect(taken).toEqual(['spawn'])

    ui.unmount()
  })

  test('enter answers with whichever choice costs nothing', async () => {
    const taken: string[] = []
    const ui = await mount({
      pending: {
        agentId: 'coder',
        because: 'is busy, and architect sent work',
        summary: 'have a look',
        answers: [
          { key: 'w', label: 'wait', tone: 'ok', take: () => taken.push('wait') },
          { key: 'd', label: 'drop it', tone: 'bad', take: () => taken.push('drop') },
        ],
        safe: 'w',
      },
    })
    await waitFor(() => ui.frame().includes('drop it'), 'the question to draw')

    // Pressed by somebody who has not read it, which is most of the time.
    await ui.send('\r')
    await waitFor(() => taken.length > 0, 'the answer to be taken')
    expect(taken).toEqual(['wait'])

    ui.unmount()
  })

  test('the agent that asked is marked, so it can be found again', async () => {
    const ui = await mount({ pending: waiting })
    await waitFor(() => ui.frame().includes('reviewer'), 'the tabs to draw')

    // A question nobody can find is an agent that never finishes.
    expect(ui.frame()).toMatch(/reviewer[^\n]*\?/)
    ui.unmount()
  })
})

describe('what the session has cost', () => {
  test('is on the row, because it is the only number that is money', async () => {
    // It was computed, handed to this screen, and read by nothing: the tray
    // showed a token count and never a figure. Tokens are the wrong unit for
    // the one question a mixed-provider team exists to answer.
    const { frame } = await mount({ totalCost: () => 0.3142 })

    // Cents under a dollar, which is what `money` has always done and what
    // reads at the sizes a single session actually reaches.
    expect(frame()).toContain('31¢')
  })

  test('says nothing rather than zero when a part of it cannot be priced', async () => {
    // `undefined` here means a model nobody publishes a price for, not a
    // session that was free, and $0.00 is the comfortable lie this whole
    // meter exists to refuse.
    const { frame } = await mount({ totalCost: () => undefined })

    expect(frame()).not.toContain('free')
    expect(frame()).not.toMatch(/\$0\.00|0\.0¢/)
  })
})

describe('news that belongs to the session and not to an agent', () => {
  test('is drawn whichever pane you are looking at', async () => {
    // The three things this exists for — what a cloned config asked for and
    // did not get, what a plugin wants to ask before it acts, and the team
    // having stopped — are nobody's in particular. Filed under an agent, each
    // would be a line in a pane somebody is not looking at, and the last is a
    // complaint about silence hidden inside the silence.
    const { frame } = await mount({
      notice: {
        title: 'nobody is working, and one handoff has no answer',
        detail: ['architect → plugin-writer, 4 minutes ago'],
        keys: [['esc', 'dismiss']],
        tone: 'ask',
      },
    })

    expect(frame()).toContain('nobody is working')
    expect(frame()).toContain('architect → plugin-writer')
  })

  test('is not there when there is nothing to say', async () => {
    const { frame } = await mount({})

    expect(frame()).not.toContain('nobody is working')
  })
})

describe('a team on a subscription and an API key at once', () => {
  test('shows the two kinds of money apart, which is the whole point', async () => {
    // One figure answers neither question: not what it cost, because it would
    // include work that came out of something already bought, and not what it
    // would have cost, because it stops at the card. This is the row the
    // project exists to draw.
    const { frame } = await mount({ totalCost: () => 0.31, onPlan: () => 1.2 })

    expect(frame()).toContain('31¢')
    expect(frame()).toContain('on plan')
  })

  test('says nothing about a plan nobody is on', async () => {
    const { frame } = await mount({ totalCost: () => 0.31 })

    expect(frame()).not.toContain('on plan')
  })
})

describe('who is waiting on whom', () => {
  test('is on the row, because nobody can hold it in their head', async () => {
    // With three agents on one job, "is anybody blocked" is a question the
    // screen could not answer: a tab says working or idle, and an idle agent
    // that somebody is waiting on looks exactly like one nobody needs.
    const { frame } = await mount({ waitingOn: () => 2 })

    expect(frame()).toContain('2 waiting')
  })

  test('says nothing when nothing has been handed over', async () => {
    const { frame } = await mount({ waitingOn: () => 0 })

    expect(frame()).not.toContain('waiting')
  })
})

describe('what a line in the transcript is, said without colour', () => {
  // Six kinds of line share one column of text. Four of them used to begin
  // with two blanks and differ only in their colour, so a transcript read
  // where colour does not survive — piped to a file, on a terminal that will
  // not take the escape, by somebody who cannot separate amber from grey —
  // could not tell a failure from a thought from a note about the session.
  const lines: SessionProps['lines'] = [
    { agentId: 'coder', kind: 'ask', text: 'make the failing test pass' },
    { agentId: 'coder', kind: 'tool', text: 'bash bun test' },
    { agentId: 'coder', kind: 'error', text: 'expected 2 keys, got 1' },
    { agentId: 'coder', kind: 'note', text: 'context 62% and counting' },
    { agentId: 'coder', kind: 'say', text: 'fixing the window instead' },
  ]

  /** The frame as a terminal with no colour would receive it. */
  const stripped = (frame: string): string =>
    frame.replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g'), '')

  test('gives every kind of line its own mark', async () => {
    const { frame } = await mount({ lines })
    const plain = stripped(frame())

    expect(plain).toContain(`${GUTTER.ask} make the failing test pass`)
    expect(plain).toContain(`${GUTTER.tool} bash bun test`)
    expect(plain).toContain(`${GUTTER.error} expected 2 keys, got 1`)
    expect(plain).toContain(`${GUTTER.note} context 62% and counting`)
    expect(plain).toContain(`${GUTTER.say} fixing the window instead`)
  })

  // Reasoning is folded away until ^r asks for it, so it has no row here to
  // assert on. Its mark is covered by the two checks below, which is what
  // there is to get wrong about a glyph nobody has looked at yet.
  test('spells no two kinds the same', () => {
    const marks = Object.values(GUTTER)
    expect(new Set(marks).size).toBe(marks.length)
  })

  test('keeps every mark one column wide, so nothing after it shifts', () => {
    // A two-column glyph here would shift every row it appears on, and the
    // ones that tempt you most — the arrows and the blocks — are exactly the
    // ones terminals disagree about.
    for (const mark of Object.values(GUTTER)) expect(widthOf(mark)).toBe(1)
  })
})

/**
 * What was typed in an earlier session comes back on the up arrow.
 *
 * The history behind the arrow lived in memory, so reopening a session left it
 * empty — and a person who wanted to send the same instruction again after a
 * restart copied the line off the screen, gutter mark and all, which is how
 * `▶ ▶ make it work` reached a model as an instruction.
 */
describe('recalling what was asked before this session', () => {
  test('reads the earlier instructions back off the transcript, per agent', () => {
    expect(
      askedBefore([
        { agentId: 'coder', kind: 'ask', text: 'make the failing test pass' },
        { agentId: 'coder', kind: 'say', text: 'done' },
        { agentId: 'reviewer', kind: 'ask', text: 'review it' },
        { agentId: 'coder', kind: 'ask', text: 'now the lint' },
      ]),
    ).toEqual({ coder: ['make the failing test pass', 'now the lint'], reviewer: ['review it'] })
  })

  test('has nothing for an agent that was never spoken to', () => {
    expect(askedBefore([{ agentId: 'coder', kind: 'note', text: 'joined' }])).toEqual({})
  })
})

/**
 * A question is answered only from the pane it was asked in.
 *
 * Side by side, the architect's "write src/x.ts?" took keys typed into the
 * coder's field: `y` approved it, `a` granted `write *` for the session, `n`
 * refused — while the same letters landed in the coder's draft.
 */
describe('a question in the other pane', () => {
  const question = (taken: string[]): Pending => ({
    agentId: 'architect',
    because: 'writes a file',
    summary: 'write src/x.ts',
    answers: [
      { key: 'y', label: 'once', tone: 'ok', take: () => taken.push('once') },
      { key: 'a', label: 'write *', tone: 'warn', take: () => taken.push('always') },
      { key: 'n', label: 'refuse', tone: 'bad', take: () => taken.push('no') },
    ],
    safe: 'n',
  })

  test('is not answered by what is typed into this one', async () => {
    const taken: string[] = []
    const ui = await mount({ split: ['architect', 'coder'], pending: question(taken) })
    await waitFor(() => printable(ui.frame()).includes('write src/x.ts'), 'the question')

    for (const key of ['y', 'a', 'n']) await ui.send(key)
    await ui.send('\r')

    expect(taken).toEqual([])
    expect(ui.sent).toEqual(['yan'])
    ui.unmount()
  })

  test('is answered from its own pane', async () => {
    const taken: string[] = []
    const ui = await mount({
      split: ['architect', 'coder'],
      pending: question(taken),
      target: 'architect',
    })
    await waitFor(() => printable(ui.frame()).includes('write src/x.ts'), 'the question')

    await ui.send('y')

    expect(taken).toEqual(['once'])
    ui.unmount()
  })

  test('esc refuses it without stopping the turn', async () => {
    // Esc is the documented safe answer. It also went to the screen's own
    // handler, which cancels the turn — so a refusal stopped the agent
    // before it could react to being refused.
    const taken: string[] = []
    const cancelled: string[] = []
    const ui = await mount({
      pending: { ...question(taken), agentId: 'coder' },
      onCancel: (id) => cancelled.push(id),
    })
    await waitFor(() => printable(ui.frame()).includes('write src/x.ts'), 'the question')

    await ui.send('\u001b')
    // A lone escape is held back by the terminal layer for a moment, in case
    // it is the start of a sequence.
    await waitFor(() => taken.length > 0, 'the safe answer')

    expect(taken).toEqual(['no'])
    expect(cancelled).toEqual([])
    ui.unmount()
  })
})

describe('control-w', () => {
  test('deletes a word without leaving the session', async () => {
    // It was bound twice: the field deleted the word, and the screen opened
    // the list of projects over it.
    const ui = await mount()
    for (const key of ['a', 'b', ' ', 'c', 'd']) await ui.send(key)

    await ui.send('\u0017')
    await ui.send('\r')

    expect(opened(ui).workspaces).toBe(0)
    expect(ui.sent).toEqual(['ab'])
    ui.unmount()
  })
})

describe('enter on an empty line while the team has stalled', () => {
  test('tells the agent the notice names to carry on', async () => {
    // The notice says "↵ tell coder to carry on", and enter on an empty line
    // sent nothing.
    const ui = await mount({
      notice: {
        title: 'nobody is working',
        detail: [],
        keys: [['↵', 'tell coder to carry on']],
        tone: 'ask',
        to: 'coder',
      },
    })

    await ui.send('\r')
    await settle()

    expect(ui.sent).toEqual(['carry on'])
    ui.unmount()
  })
})

function opened(ui: { opened: { workspaces: number } }): { workspaces: number } {
  return ui.opened
}

/**
 * Copying what an agent said, by dragging over it.
 *
 * The mouse belongs to the interface — a click picks an agent, a drag moves a
 * divider — so selecting text needed ^p to hand it back to the terminal
 * first, and everybody found that out by trying to copy something and getting
 * nothing at all.
 */
describe('dragging over a pane', () => {
  const said = (text: string): Line => ({ agentId: 'coder', kind: 'say', text })
  const lines = [said('the first thing'), said('the second thing'), said('the third thing')]

  /** A drag: press, move with the motion bit set, release. */
  async function dragOver(
    ui: Awaited<ReturnType<typeof mount>>,
    from: [number, number],
    to: [number, number],
  ): Promise<void> {
    await ui.send(press(from[0] + 1, from[1] + 1))
    await ui.send(press(to[0] + 1, to[1] + 1, 32))
    await ui.send(press(to[0] + 1, to[1] + 1, 0, 'm'))
  }

  test('copies the rows it covered, and says how many', async () => {
    const copied: string[] = []
    const ui = await mount({
      lines,
      onCopy: async (text) => {
        copied.push(text)
        return true
      },
    })
    // The transcript is bottom-aligned inside the pane, and under it sit the
    // rule, the row you type in, the rule above the tray and the tray: its
    // last row is five up from the bottom of the window.
    const bottom = ROWS - 5

    await dragOver(ui, [10, bottom - 2], [10, bottom])
    await waitFor(() => copied.length > 0, 'the copy')

    expect(copied[0]).toContain('the second thing')
    expect(copied[0]).toContain('the third thing')
    await waitFor(() => printable(ui.frame()).includes('copied'), 'the tray to say so')
    ui.unmount()
  })

  test('a click copies nothing, because a click is how an agent is chosen', async () => {
    const copied: string[] = []
    const ui = await mount({
      lines,
      onCopy: async (text) => {
        copied.push(text)
        return true
      },
    })

    await ui.click(10, ROWS - 5)
    await settle()

    expect(copied).toEqual([])
    ui.unmount()
  })
})

/**
 * A long message, while it is being typed.
 *
 * The field was one row that truncated, so an instruction worth writing —
 * which is a long one — scrolled sideways out of the window as it was typed,
 * and there was no way to read back what you had written before sending it.
 */
describe('typing more than fits on one row', () => {
  const words = (count: number) => Array.from({ length: count }, (_, at) => `word${at}`).join(' ')

  test('the field grows downwards, and the whole message stays readable', async () => {
    const ui = await mount()

    await ui.send(words(30))
    await waitFor(() => printable(ui.frame()).includes('word29'), 'the end of the message')

    // The beginning and the end of what was typed are both on the screen.
    const frame = printable(ui.frame())
    expect(frame).toContain('word0')
    expect(frame).toContain('word29')
    ui.unmount()
  })

  test('what is sent is the whole message, not the row the cursor was on', async () => {
    const ui = await mount()

    await ui.send(words(30))
    await waitFor(() => printable(ui.frame()).includes('word29'), 'the message')
    await ui.send('\r')
    await waitFor(() => ui.sent.length > 0, 'the message to be sent')

    expect(ui.sent).toHaveLength(1)
    expect(ui.sent[0]).toBe(words(30))
    ui.unmount()
  })

  test('a message far longer than the field keeps its end, where the cursor is', async () => {
    // A field that scrolled away from the cursor would be worse than one that
    // truncates: you could not see what you were typing.
    const ui = await mount()

    await ui.send(words(200))
    await waitFor(() => printable(ui.frame()).includes('word199'), 'the end of the message')

    expect(printable(ui.frame())).toContain('word199')
    ui.unmount()
  })
})
