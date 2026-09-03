import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { GRAPHITE } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import { projectPath, Workspaces } from './workspaces.tsx'

function drawn(node: React.ReactNode): string {
  const written: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      written.push(chunk)
      return true
    },
    columns: 90,
    rows: 40,
    isTTY: true,
  })
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    read: () => null,
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  })
  const app = render(<ThemeProvider value={GRAPHITE}>{node}</ThemeProvider>, {
    stdin: stdin as never,
    stdout: stdout as never,
    patchConsole: false,
  })
  app.unmount()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
  return written.join('').replace(/\[[0-9;?]*[a-zA-Z]/g, '')
}

/**
 * What you typed, as a directory.
 *
 * Starting a project used to mean typing an absolute path to a directory that
 * already existed, which puts two chores before the thing you actually wanted:
 * work out where you are, and go and make it first.
 */
describe('where a project goes when you name one', () => {
  const cwd = '/repos'
  const home = '/home/ada'

  test('a bare name lands beside where you are, which is what you meant', () => {
    expect(projectPath('inventory', cwd, home)).toBe('/repos/inventory')
  })

  test('a name with a directory in it is still relative to where you are', () => {
    expect(projectPath('work/inventory', cwd, home)).toBe('/repos/work/inventory')
  })

  test('an absolute path is taken as given', () => {
    expect(projectPath('/srv/thing', cwd, home)).toBe('/srv/thing')
  })

  test('a tilde means the home directory, because everybody types it', () => {
    expect(projectPath('~/thing', cwd, home)).toBe('/home/ada/thing')
    expect(projectPath('~', cwd, home)).toBe('/home/ada')
  })

  test('a leading ./ is the same as no prefix at all', () => {
    expect(projectPath('./thing', cwd, home)).toBe('/repos/thing')
  })

  test('climbing out with .. is resolved rather than left in the path', () => {
    expect(projectPath('../elsewhere', cwd, home)).toBe('/elsewhere')
  })

  test('surrounding blanks are somebody pasting, not somebody deciding', () => {
    expect(projectPath('  inventory  ', cwd, home)).toBe('/repos/inventory')
  })

  test('nothing typed is nothing resolved', () => {
    expect(projectPath('   ', cwd, home)).toBeUndefined()
  })
})

describe('starting a project that is not there yet', () => {
  const props = {
    known: [],
    cwd: '/repos',
    home: '/home/ada',
    onOpen: () => {},
    onForget: () => {},
    onForgetAll: () => {},
    exists: () => false,
    validate: async () => ({ ok: true }) as const,
  }

  test('shows where a typed name would actually land', () => {
    // Typing "inventory" and being shown "inventory" answers nothing: the
    // question in the room is which directory that is.
    const frame = drawn(<Workspaces {...props} initialDraft="inventory" />)

    expect(frame).toContain('/repos/inventory')
  })

  test('says it will be made, rather than refusing because it is not there', () => {
    const frame = drawn(<Workspaces {...props} initialDraft="inventory" />)

    expect(frame).toMatch(/will be created|creating/i)
  })

  test('says nothing about creating one that already exists', () => {
    const frame = drawn(<Workspaces {...props} exists={() => true} initialDraft="inventory" />)

    expect(frame).not.toMatch(/will be created/i)
  })

  test('suggests a name rather than a path, since a name is what it takes', () => {
    const frame = drawn(<Workspaces {...props} />)

    expect(frame).not.toContain('/path/to/your/project')
  })
})

describe('forgetting the projects it remembers', () => {
  const known = [
    { path: '/repos/one', name: 'one', lastOpened: 2 },
    { path: '/repos/two', name: 'two', lastOpened: 1 },
  ]

  test('offers to forget all of them, not one at a time', () => {
    const frame = drawn(
      <Workspaces
        known={known}
        cwd="/repos"
        home="/home/ada"
        onOpen={() => {}}
        onForget={() => {}}
        onForgetAll={() => {}}
        exists={() => true}
        validate={async () => ({ ok: true })}
      />,
    )

    expect(frame).toMatch(/forget all/i)
  })

  test('says how many it is about to forget before it does', () => {
    // Forgetting one is a keystroke you can repeat; forgetting the list is
    // the one that is worth a sentence first. Nothing on disk is touched
    // either way, and the sentence should say so.
    const frame = drawn(
      <Workspaces
        known={known}
        cwd="/repos"
        home="/home/ada"
        onOpen={() => {}}
        onForget={() => {}}
        onForgetAll={() => {}}
        exists={() => true}
        validate={async () => ({ ok: true })}
        confirmingForgetAll
      />,
    )

    expect(frame).toContain('2')
    expect(frame).toMatch(/nothing on disk|no files|left alone/i)
  })
})

describe('a project whose path is longer than the room for it', () => {
  test('keeps the name and the path apart', () => {
    // space-between puts one at each edge and lets them meet in the middle
    // when they do not both fit, so a temporary directory ran straight into
    // its own name: "aidcrew-demo-Ochvf6/private/var/folders/…" reads as one
    // string and neither half is legible.
    const frame = drawn(
      <Workspaces
        known={[
          {
            path: '/private/var/folders/n0/s619yhq953bdp1k85z3bhc6w0000gn/T/aidcrew-demo-Ochvf6',
            name: 'aidcrew-demo-Ochvf6',
            lastOpened: 1,
          },
        ]}
        cwd="/repos"
        home="/home/ada"
        onOpen={() => {}}
        onForget={() => {}}
        onForgetAll={() => {}}
        exists={() => true}
        validate={async () => ({ ok: true })}
      />,
    )

    // One row, and the name whole. It wrapped instead — the name broken
    // across two lines and the path over two more, four lines for one entry
    // and none of them readable.
    const row = frame.split('\n').find((line) => line.includes('aidcrew-demo')) ?? ''

    expect(row).toContain('aidcrew-demo-Ochvf6')
    expect(row).not.toContain('aidcrew-demo-Ochvf6/private')
    // One distinct row. A screen that fills the window is written once on
    // mount and again on the way out, so the same row appears twice here —
    // what would say it had wrapped is two DIFFERENT rows carrying halves of
    // it.
    const rows = new Set(frame.split('\n').filter((line) => line.includes('aidcrew-demo')))
    expect([...rows]).toHaveLength(1)
  })
})
