import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { attachNativeTerminal } from './native-attach.ts'

function fixture() {
  const input = Object.assign(new PassThrough(), { setRawMode: (_raw: boolean) => {} })
  const output = Object.assign(new PassThrough(), { columns: 90, rows: 30 })
  const writes: string[] = []
  const frames: string[] = []
  output.on('data', (data) => frames.push(String(data)))
  let listener: { data(data: Uint8Array): void; exit(code: number | null): void } | undefined
  let subscribed = false
  let paused = false
  const sizes: number[][] = []
  const session = {
    closed: false,
    history: () => new TextEncoder().encode('existing transcript'),
    write: (data: string) => {
      writes.push(data)
    },
    resize: (cols: number, rows: number) => {
      sizes.push([cols, rows])
    },
    subscribe: (next: NonNullable<typeof listener>) => {
      listener = next
      subscribed = true
      return () => {
        subscribed = false
      }
    },
  }
  const keyboard = {
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
    },
  }
  return {
    input,
    output,
    writes,
    frames,
    sizes,
    session,
    keyboard,
    get listener() {
      return listener
    },
    get subscribed() {
      return subscribed
    },
    get paused() {
      return paused
    },
  }
}

test('attaches existing history, relays native commands, and detaches without closing the session', async () => {
  const f = fixture()
  const done = attachNativeTerminal(f.session, f.keyboard, f.input as never, f.output as never)
  expect(f.paused).toBe(true)
  expect(f.frames.join('')).toContain('existing transcript')
  f.input.write('/model\r')
  expect(f.writes).toEqual(['/model\r'])
  f.listener?.data(new TextEncoder().encode('native menu'))
  expect(f.frames.join('')).toContain('native menu')
  f.output.columns = 100
  f.output.emit('resize')
  expect(f.sizes.at(-1)).toEqual([100, 30])
  f.input.write('\u001d')
  await done
  expect(f.paused).toBe(false)
  expect(f.subscribed).toBe(false)
  expect(f.session.closed).toBe(false)
  expect(f.input.listenerCount('data')).toBe(0)
})

test('restores harness ownership when the native process exits', async () => {
  const f = fixture()
  const done = attachNativeTerminal(f.session, f.keyboard, f.input as never, f.output as never)
  f.listener?.exit(0)
  await done
  expect(f.paused).toBe(false)
  expect(f.subscribed).toBe(false)
  expect(f.output.listenerCount('resize')).toBe(0)
})

test('returns terminal ownership after a native stream failure', async () => {
  const f = fixture()
  f.session.write = () => {
    throw new Error('Native stream closed')
  }
  const done = attachNativeTerminal(f.session, f.keyboard, f.input as never, f.output as never)
  f.input.write('message')
  await expect(done).rejects.toThrow('Native stream closed')
  expect(f.paused).toBe(false)
  expect(f.subscribed).toBe(false)
})
