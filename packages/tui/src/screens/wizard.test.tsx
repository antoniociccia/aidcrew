import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { GRAPHITE } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import { KeyStep } from './wizard.tsx'

/** Everything Ink wrote, without the escapes that made it colourful. */
function drawn(node: React.ReactNode): string {
  const written: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      written.push(chunk)
      return true
    },
    columns: 100,
    rows: 30,
    isTTY: true,
  })
  const app = render(<ThemeProvider value={GRAPHITE}>{node}</ThemeProvider>, {
    stdout: stdout as never,
    patchConsole: false,
  })
  app.unmount()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
  return written.join('').replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '')
}

describe('the first run, for somebody with no key at all', () => {
  test('has somewhere to send them', () => {
    // The key screen submits nothing on an empty key, so somebody who has
    // just downloaded the binary and has no account could go neither forward
    // nor back: ctrl-c was the only way out, which is a first run that ends
    // in quitting.
    const frame = drawn(
      <KeyStep provider="zen" apiKey="" onChange={() => {}} onSubmit={() => {}} />,
    )

    expect(frame).toContain('aidcrew demo')
  })
})
