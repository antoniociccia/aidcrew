import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { GRAPHITE } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import { PAGES, Tour } from './tour.tsx'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * Waits for something to become true rather than for a length of time.
 *
 * Ink throttles what it writes and React renders later still, so a fixed
 * sleep decides whether these pass by how fast the machine is.
 */
async function waitFor(condition: () => boolean, what: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return
    await tick()
  }
  throw new Error(`waited for ${what} and it never happened`)
}

const ESC = String.fromCharCode(27)
/** What a terminal sends for the left arrow. */
const LEFT = `${ESC}[D`

/** Which page the newest frame says it is on. */
function lastCounter(frame: string): number {
  const seen = [...frame.matchAll(/(\d+) of \d+/g)].map((match) => Number(match[1]))
  return seen[seen.length - 1] ?? 0
}

/** What was drawn, with the escapes that coloured and moved it taken out. */
function printable(written: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
  return written.replace(/\[[0-9;?]*[a-zA-Z]/g, '')
}

async function open() {
  const frames: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      frames.push(chunk)
      return true
    },
    columns: 100,
    rows: 30,
    isTTY: true,
  })
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

  let closed = 0
  const app = render(
    <ThemeProvider value={GRAPHITE}>
      <Tour
        onClose={() => {
          closed += 1
        }}
      />
    </ThemeProvider>,
    { stdin: stdin as never, stdout: stdout as never, patchConsole: false },
  )
  await tick()

  return {
    frame: () => printable(frames.join('')),
    closed: () => closed,
    press: async (data: string) => {
      queued = data
      stdin.emit('readable')
      await tick()
    },
    unmount: () => app.unmount(),
  }
}

/**
 * A first run used to end at a cursor.
 *
 * The team was made, and nothing had said what a team is for, what happens
 * when two agents want the same file, or where the work goes.
 */
describe('the tour', () => {
  test('opens on what this is, and says how far through it you are', async () => {
    const ui = await open()

    expect(ui.frame()).toContain('A team, not an assistant')
    expect(ui.frame()).toContain(`1 of ${PAGES.length}`)
    ui.unmount()
  })

  test('enter goes forward and the left arrow comes back', async () => {
    const ui = await open()

    await ui.press('\r')
    await waitFor(() => ui.frame().includes(PAGES[1]?.title ?? ''), 'the second page')

    await ui.press(LEFT)
    // The counter, not the title: every page drawn so far is still in the
    // accumulated writes, and only the counter says which one is on screen.
    await waitFor(() => lastCounter(ui.frame()) === 1, 'the first page again')
    ui.unmount()
  })

  test('enter on the last page starts the session, rather than needing escape', async () => {
    // A tour you have to escape from is a tour that ends by being interrupted.
    const ui = await open()

    for (let at = 0; at < PAGES.length - 1; at++) {
      await ui.press('\r')
      await waitFor(() => ui.frame().includes(PAGES[at + 1]?.title ?? ''), `page ${at + 2}`)
    }
    expect(ui.closed()).toBe(0)

    await ui.press('\r')
    await waitFor(() => ui.closed() > 0, 'the tour to end')
    expect(ui.closed()).toBe(1)
    ui.unmount()
  })

  test('escape skips it, from anywhere', async () => {
    const ui = await open()

    await ui.press(ESC)
    // A lone escape is held back for a moment, in case it starts a sequence.
    await waitFor(() => ui.closed() > 0, 'the tour to be skipped')

    expect(ui.closed()).toBe(1)
    ui.unmount()
  })

  test('every page says something, and names keys that exist', async () => {
    // A page with an empty key is a page that teaches a wrong thing.
    for (const page of PAGES) {
      expect(page.title).not.toBe('')
      expect(page.body.some((row) => row.trim() !== '')).toBe(true)
      for (const [key] of page.keys ?? []) expect(key).not.toBe('')
    }
  })
})
