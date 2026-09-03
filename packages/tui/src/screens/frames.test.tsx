import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { AgentSnapshot, Task } from '@aidcrew/core'
import { render } from 'ink'
import type React from 'react'
import { widthOf } from '../components/text-width.ts'
import { GRAPHITE } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import { Keys } from './keys.tsx'
import { Notices } from './notices.tsx'
import { Opening } from './opening.tsx'
import type { Line, Pending, SessionProps } from './session.tsx'
import { Session } from './session.tsx'
import { Settings } from './settings.tsx'
import { Tasks } from './tasks.tsx'
import { TeamEditor } from './team-editor.tsx'
import { Tour } from './tour.tsx'
import { Wizard } from './wizard.tsx'
import { Workspaces } from './workspaces.tsx'

/**
 * Every frame is the terminal's height, and nothing ever clears the screen.
 *
 * Ink draws a frame by erasing the lines of the previous one and writing the
 * new ones. It clears the whole terminal only when a frame is taller than the
 * window, when the previous one was, or when a frame shorter than the window
 * follows one that filled it — and a clear is the flicker: the screen goes
 * blank and comes back. So the one property every screen has to hold, whatever
 * it is showing, is that its frame is exactly the window's height. The wizard,
 * the list of projects and the team editor did not hold it, so opening any of
 * them from the session blanked the terminal on the way in.
 */

const CLEAR = '[2J'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

async function waitFor(condition: () => boolean, what: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return
    await tick()
  }
  throw new Error(`waited for ${what} and it never happened`)
}

/** What was drawn, with the escapes that coloured and moved it taken out. */
function printable(written: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
  return written.replace(/\[[0-9;?]*[a-zA-Z]/g, '')
}

/**
 * Whether a write is a frame rather than a mode switch or a cursor move.
 *
 * Mouse reporting, synchronised output and the cursor are all written on the
 * same stream, and none of them is anything a person sees.
 */
const isFrame = (chunk: string): boolean => printable(chunk).trim() !== '' || chunk.includes('\n')

/** The widest row a frame has, in columns, as the terminal would count it. */
const widest = (frames: string[]): number =>
  Math.max(0, ...frames.flatMap((frame) => printable(frame).split('\n').map(widthOf)))

function terminal(rows: number, columns: number) {
  const chunks: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    columns,
    rows,
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

  return {
    chunks,
    stdout,
    stdin,
    type: async (data: string): Promise<void> => {
      queued = data
      stdin.emit('readable')
      await tick()
    },
  }
}

const agent = (id: string): AgentSnapshot => ({
  id,
  model: 'muse-spark-1.2',
  status: id === 'coder' ? 'working' : 'idle',
  usage: { inputTokens: 1200, outputTokens: 300 },
  turns: 1,
  workspace: `/repo/.aidcrew/wt/${id}`,
  isolated: true,
  yolo: false,
  queued: 0,
  behind: 0,
  activity: [],
})

const agents = [agent('architect'), agent('coder'), agent('reviewer')]

const WORDS =
  'the quick brown fox jumps over the lazy dog and keeps going until the row folds'.split(' ')

/** A line long enough to fold, and different each time so nothing is cached by accident. */
const line = (at: number): Line => ({
  agentId: at % 5 === 0 ? 'architect' : 'coder',
  kind: at % 7 === 3 ? 'tool' : at % 11 === 5 ? 'note' : 'say',
  text: `${at}: ${Array.from({ length: 6 + (at % 17) }, (_, k) => WORDS[(at + k) % WORDS.length]).join(' ')}`,
})

const pending: Pending = {
  agentId: 'coder',
  because: 'runs a command',
  summary: 'rm -rf build',
  answers: [
    { key: 'y', label: 'once', tone: 'ok', take: () => {} },
    { key: 'n', label: 'refuse', tone: 'bad', take: () => {} },
  ],
  safe: 'n',
}

const stalled: SessionProps['notice'] = {
  title: 'nobody is working, and one handoff has no answer',
  detail: [
    'architect → plugin-writer, 4 minutes ago',
    'its turn ran out of room before it answered',
  ],
  keys: [['↵', 'tell plugin-writer to carry on']],
  tone: 'ask',
}

const session = (lines: Line[], over: Partial<SessionProps> = {}) => (
  <Session
    workspace="repo"
    agents={agents}
    lines={lines}
    target="coder"
    onTarget={() => {}}
    onSend={() => {}}
    onOpenSettings={() => {}}
    onOpenAgents={() => {}}
    onSwitchWorkspace={() => {}}
    onQuit={() => {}}
    {...over}
  />
)

const wizard = (
  <Wizard
    providers={['zen', 'anthropic']}
    saveKey={async () => {}}
    listModels={async () => ({ kind: 'unavailable', reason: 'no endpoint' })}
    onDone={() => {}}
    onCancel={() => {}}
  />
)

const settings = (
  <Settings
    known={[]}
    providers={['zen']}
    agents={[]}
    models={[]}
    defaults={{}}
    themes={[{ name: 'crew', fill: 'hairline' }]}
    theme="crew"
    plugins={[]}
    sources={[]}
    sharedMemory={false}
    hidePaths={false}
    cwd="/repo"
    storePath="/store"
    onSaveKey={async () => {}}
    onForgetKey={async () => {}}
    onSetDefault={() => {}}
    onSharedMemory={() => {}}
    onHidePaths={() => {}}
    onSetTheme={() => {}}
    onSetFill={() => {}}
    onSetSources={() => {}}
    onWritePlugin={() => {}}
    onClose={() => {}}
  />
)

const workspaces = (
  <Workspaces
    known={[{ path: '/repos/one', name: 'one', lastOpened: 1 }]}
    cwd="/repos"
    home="/home/ada"
    onOpen={() => {}}
    onForget={() => {}}
    onForgetAll={() => {}}
    exists={() => true}
    validate={async () => ({ ok: true })}
  />
)

const task: Task = { name: 'main', path: '/repo', head: 'abc', changed: 0, behind: 0, main: true }

const tasks = (
  <Tasks tasks={[task]} current="main" onChoose={() => {}} onNew={() => {}} onClose={() => {}} />
)

const team = (
  <TeamEditor
    agents={[{ id: 'coder', description: 'writes code', systemPrompt: 'write code' }]}
    providers={['zen']}
    shared={[]}
    onAdd={async () => {}}
    onRemove={async () => {}}
    onSetModel={async () => {}}
    listModels={async () => ({ kind: 'unavailable', reason: 'no endpoint' })}
    onClose={() => {}}
  />
)

const notices = <Notices notices={[]} agents={['coder']} onGo={() => {}} onClose={() => {}} />

const history = Array.from({ length: 40 }, (_, at) => line(at))

/** Every screen, and every state of the session that changes its shape. */
const screens: [string, React.ReactNode, string[]][] = [
  ['the session', session(history), []],
  ['the session with nothing said yet', session([]), []],
  ['the session with a notice over it', session(history, { notice: stalled }), []],
  ['the session with a question waiting', session(history, { pending }), []],
  ['the session side by side', session(history, { initialSplit: ['architect', 'coder'] }), []],
  [
    'the session side by side with a question waiting',
    session(history, { initialSplit: ['architect', 'coder'], pending }),
    [],
  ],
  ['the session while a command is being typed', session(history), ['/sp']],
  // The field grows downwards as a long message is typed, taking rows from
  // the conversation: what it must never do is take rows from the window.
  [
    'the session with a long message half-typed',
    session(history),
    [Array.from({ length: 40 }, (_, at) => `word${at}`).join(' ')],
  ],
  [
    'the session with a message longer than the field can show',
    session(history),
    [Array.from({ length: 200 }, (_, at) => `word${at}`).join(' ')],
  ],
  ['the file finder', session(history, { files: ['a.ts', 'src/b.ts'] }), ['']],
  ['the split picker', session(history), ['']],
  ['the wizard', wizard, []],
  ['the settings', settings, []],
  ['the list of projects', workspaces, []],
  ['the list of tasks', tasks, []],
  ['the team editor', team, []],
  ['the notices', notices, []],
  ['the board of keys', <Keys key="keys" onClose={() => {}} />, []],
  ['the opening panel', <Opening key="opening" />, []],
  ['the tour', <Tour key="tour" onClose={() => {}} />, []],
]

/**
 * The height of every frame, as Ink counted it.
 *
 * Read in Ink's debug mode, where each frame is written whole and unthrottled:
 * on a live terminal Ink appends a newline to a frame shorter than the window,
 * and a frame whose last row is blank ends in one too, so the two cannot be
 * told apart from what reaches the stream.
 */
async function heightsOf(
  node: React.ReactNode,
  rows: number,
  columns: number,
  keys: string[],
): Promise<{ heights: number[]; widest: number }> {
  const fake = terminal(rows, columns)
  const app = render(<ThemeProvider value={GRAPHITE}>{node}</ThemeProvider>, {
    stdin: fake.stdin as never,
    stdout: fake.stdout as never,
    patchConsole: false,
    debug: true,
  })
  await waitFor(() => fake.chunks.some(isFrame), 'the first frame')
  for (const key of keys) await fake.type(key)
  await tick()

  const frames = fake.chunks.filter(isFrame)
  app.unmount()
  return { heights: frames.map((frame) => frame.split('\n').length), widest: widest(frames) }
}

describe.each([
  [20, 60],
  [50, 160],
])('on a terminal of %i rows by %i columns', (rows, columns) => {
  test.each(screens)('%s is exactly the height of the window', async (_name, node, keys) => {
    const drawn = await heightsOf(node, rows, columns, keys)

    expect([...new Set(drawn.heights)]).toEqual([rows])
    // A row wider than the window wraps, which is a frame taller than Ink
    // believes it is, and every erase after that lands one row off.
    expect(drawn.widest).toBeLessThanOrEqual(columns)
  })
})

describe('streaming into the session', () => {
  test('three hundred lines arrive without a clear, and every frame fills the window', async () => {
    const rows = 30
    const columns = 100
    const fake = terminal(rows, columns)
    const tree = (lines: Line[]) => (
      <ThemeProvider value={GRAPHITE}>{session(lines, { rows, columns })}</ThemeProvider>
    )
    const app = render(tree([]), {
      stdin: fake.stdin as never,
      stdout: fake.stdout as never,
      patchConsole: false,
    })
    await waitFor(() => fake.chunks.some(isFrame), 'the first frame')

    // Fed the way the runtime feeds them: a fresh array on every change, one
    // line at a time, faster than the terminal is allowed to draw.
    const from = fake.chunks.length
    let lines: Line[] = []
    for (let at = 0; at < 300; at++) {
      lines = [...lines, line(at)]
      app.rerender(tree(lines))
      await tick()
    }
    for (let beat = 0; beat < 10; beat++) await tick()

    const written = fake.chunks.slice(from)
    app.unmount()
    const frames = written.filter(isFrame)

    expect(written.some((chunk) => chunk.includes(CLEAR))).toBe(false)
    expect(frames.length).toBeGreaterThan(0)
    // Ink's throttle is what turns three hundred changes into a few dozen
    // frames; a frame per change would be more writing than reading.
    expect(frames.length).toBeLessThanOrEqual(300)
    for (const frame of frames) {
      // A frame that fills the window is written without a trailing newline,
      // which is how Ink says it did not have to scroll for it.
      expect(frame.endsWith('\n')).toBe(false)
      expect(frame.split('\n').length).toBe(rows)
    }
    expect(widest(frames)).toBeLessThanOrEqual(columns)
  }, 20_000)
})

describe('moving between screens', () => {
  test.each([
    [20, 60],
    [30, 100],
  ])('never clears a terminal of %i by %i', async (rows, columns) => {
    // Leaving a frame that filled the window for one that does not is the
    // third of Ink's reasons to clear, and it is the one a person meets most:
    // every screen opened from the session used to blank the terminal first.
    const fake = terminal(rows, columns)
    const wrap = (node: React.ReactNode) => <ThemeProvider value={GRAPHITE}>{node}</ThemeProvider>
    const app = render(wrap(session(history)), {
      stdin: fake.stdin as never,
      stdout: fake.stdout as never,
      patchConsole: false,
    })
    await waitFor(() => fake.chunks.some(isFrame), 'the first frame')

    const from = fake.chunks.length
    for (const [, node] of screens) {
      app.rerender(wrap(node))
      await tick()
      app.rerender(wrap(session(history)))
      await tick()
    }
    for (let beat = 0; beat < 10; beat++) await tick()

    const written = fake.chunks.slice(from)
    app.unmount()

    expect(written.some((chunk) => chunk.includes(CLEAR))).toBe(false)
  })
})
