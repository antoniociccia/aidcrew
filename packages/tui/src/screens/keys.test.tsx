import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { GRAPHITE } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import { GROUPS, Keys } from './keys.tsx'

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
  return written.join('').replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '')
}

describe('the board of every key', () => {
  test('lists every shortcut the session actually binds', () => {
    // Fifteen of them and room for six on the tray, so the rest were
    // discoverable only by reading the source.
    const listed = GROUPS.flatMap((group) => group.keys.map((key) => key.keys)).join(' ')

    for (const key of ['^e', '^k', '^n', '^s', '^w', '^l', '^t', '^r', '^p', '^x', '^u', '^c']) {
      expect(listed).toContain(key)
    }
  })

  test('says how to close it, since anything closes it', () => {
    expect(drawn(<Keys onClose={() => {}} rows={40} columns={90} />)).toContain('esc')
  })

  test('says what opened it, when something unbound did', () => {
    // Pressing control and a letter you half-remember is the moment you
    // wanted this, and the board should say so rather than appear for no
    // stated reason.
    const frame = drawn(
      <Keys onClose={() => {}} because="that key does nothing" rows={40} columns={90} />,
    )

    expect(frame).toContain('that key does nothing')
  })
})
