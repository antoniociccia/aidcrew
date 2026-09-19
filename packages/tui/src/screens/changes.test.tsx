import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { GRAPHITE } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import type { ChangeRow } from './changes.tsx'
import { Changes, changeRows } from './changes.tsx'

const COLUMNS = 100
const ROWS = 30

/** What the terminal sends for the two keys these tests press. */
const ENTER = '\r'
const ESCAPE = ''

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

function printable(written: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
  return written.replace(/\[[0-9;?]*[a-zA-Z]/g, '')
}

async function waitFor(condition: () => boolean, what: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return
    await tick()
  }
  throw new Error(`waited for ${what} and it never happened`)
}

const row = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  at: 0,
  hunk: 0,
  agentId: 'coder',
  file: 'src/rates.ts',
  when: Date.now(),
  added: 2,
  removed: 1,
  rows: ['~ src/rates.ts +2 -1', '- 2   const rate = 0.2', '+ 2   const rate = config.rate'],
  ...over,
})

function mount(over: { changes?: ChangeRow[]; outcome?: string } = {}) {
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

  const reverted: { file: string; reason: string; anyway: boolean }[] = []
  let closed = 0

  const app = render(
    <ThemeProvider value={GRAPHITE}>
      <Changes
        changes={over.changes ?? [row()]}
        onRevert={async (change, reason, anyway) => {
          reverted.push({ file: change.file, reason, anyway })
          return over.outcome ?? `put back ${change.file}`
        }}
        onClose={() => {
          closed += 1
        }}
      />
    </ThemeProvider>,
    // biome-ignore lint/suspicious/noExplicitAny: a stub terminal is not a Writable
    { stdout: stdout as any, stdin: stdin as any, patchConsole: false },
  )

  /**
   * The last frame that drew anything.
   *
   * Ink writes cursor moves and mode switches on the same stream, so the very
   * last chunk is often an escape sequence with no text in it at all.
   */
  const last = (): string =>
    printable([...frames].reverse().find((frame) => printable(frame).trim() !== '') ?? '')
  return { app, type, last, reverted, closed: () => closed, frames }
}

describe('the changes screen', () => {
  test('says whose change it is, which file, and shows the lines', async () => {
    const screen = mount()
    await tick()

    expect(screen.last()).toContain('src/rates.ts')
    expect(screen.last()).toContain('coder')
    expect(screen.last()).toContain('const rate = config.rate')
    screen.app.unmount()
  })

  test('asks why before taking anything back', async () => {
    const screen = mount()
    await tick()

    screen.type('x')
    await waitFor(() => screen.last().toLowerCase().includes('why'), 'the reason to be asked')

    expect(screen.reverted).toHaveLength(0)
    screen.app.unmount()
  })

  test('takes it back with the reason that was typed', async () => {
    const screen = mount()
    await tick()

    screen.type('x')
    await waitFor(() => screen.last().toLowerCase().includes('why'), 'the reason to be asked')
    screen.type('no default')
    await tick()
    screen.type(ENTER)
    await waitFor(() => screen.reverted.length === 1, 'the change to be taken back')

    expect(screen.reverted[0]).toEqual({
      file: 'src/rates.ts',
      reason: 'no default',
      anyway: false,
    })
    screen.app.unmount()
  })

  test('a reason is optional: enter alone still takes it back', async () => {
    const screen = mount()
    await tick()

    screen.type('x')
    await waitFor(() => screen.last().toLowerCase().includes('why'), 'the reason to be asked')
    screen.type(ENTER)
    await waitFor(() => screen.reverted.length === 1, 'the change to be taken back')

    expect(screen.reverted[0]?.reason).toBe('')
    screen.app.unmount()
  })

  test('escape from the reason leaves the change where it is', async () => {
    const screen = mount()
    await tick()

    screen.type('x')
    await waitFor(() => screen.last().toLowerCase().includes('why'), 'the reason to be asked')
    screen.type(ESCAPE)
    await tick()

    expect(screen.reverted).toHaveLength(0)
    expect(screen.closed()).toBe(0)
    screen.app.unmount()
  })

  test('what came of it is said on the screen', async () => {
    const screen = mount({ outcome: 'that would discard 2 later changes to src/rates.ts' })
    await tick()

    screen.type('x')
    await waitFor(() => screen.last().toLowerCase().includes('why'), 'the reason to be asked')
    screen.type(ENTER)
    await waitFor(() => screen.last().includes('2 later changes'), 'the outcome to be reported')

    screen.app.unmount()
  })

  test('an empty list says so rather than showing nothing', async () => {
    const screen = mount({ changes: [] })
    await tick()

    expect(screen.last().toLowerCase()).toContain('nothing')
    screen.app.unmount()
  })
})

describe('turning what the guard kept into rows', () => {
  test('gives one row per hunk, with the lines of each', () => {
    const rows = changeRows([
      {
        at: 1,
        path: '.aidcrew/wt/rates/src/rates.ts',
        file: 'src/rates.ts',
        task: 'rates',
        agentId: 'coder',
        when: 2,
        hunks: [
          { oldStart: 1, oldLines: ['a'], newStart: 1, newLines: ['A'] },
          { oldStart: 9, oldLines: ['i'], newStart: 9, newLines: ['I'] },
        ],
      },
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ at: 1, hunk: 0, file: 'src/rates.ts', task: 'rates' })
    expect(rows[0]?.rows).toContain('+ 1 A')
    expect(rows[1]?.hunk).toBe(1)
  })
})
