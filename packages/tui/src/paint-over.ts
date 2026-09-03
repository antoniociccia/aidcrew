/**
 * Drawing each frame over the last one, instead of after wiping it.
 *
 * Ink redraws by erasing every row of the previous frame — erase a line,
 * climb one, forty-four times — and then writing the new frame under it. It
 * brackets the two in a synchronised update so a terminal paints them
 * together, and on a terminal that honours the bracket nothing shows. Several
 * do not: Terminal.app, and the xterm.js inside every browser-based terminal,
 * paint whenever bytes arrive. There the wipe is visible — one frame of black
 * with the top rows of the new frame on it — whenever a frame is big enough to
 * reach the terminal in more than one piece, which a full screen of colour is.
 *
 * So the wipe is taken out. The cursor climbs to the same place without
 * erasing, every row is written and *then* cleared to its right, and whatever
 * is left below the last row is cleared last. Painted mid-way, that shows a
 * screen that is partly the old frame and partly the new one — which is what
 * a screen being redrawn looks like, and nobody sees it.
 *
 * Only the wipe is recognised and rewritten. The first frame, a full clear
 * after an overflow, cursor movements and the update brackets pass through
 * untouched: they are not the problem, and second-guessing them would be.
 */
import type { WriteStream } from 'node:tty'

const ESC = '\u001b'
const ERASE_LINE = `${ESC}[2K`
const UP = `${ESC}[1A`
const COLUMN_ZERO = `${ESC}[G`
const ERASE_RIGHT = `${ESC}[K`
const ERASE_BELOW = `${ESC}[J`

/** The wipe: erase and climb, some number of times, then erase and return. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the wipe is made of escape sequences, and matching it is the point
const WIPE = /^((?:\u001b\[2K\u001b\[1A)*)\u001b\[2K\u001b\[G/

/**
 * A frame as Ink wrote it, with the wipe replaced by a climb. Anything that
 * does not begin with the wipe is returned as it came.
 */
export function repaint(chunk: string): string {
  const wipe = WIPE.exec(chunk)
  if (!wipe) return chunk

  const climbed = (wipe[1] ?? '').length / (ERASE_LINE + UP).length
  const climb = climbed > 0 ? `${ESC}[${climbed}A` : ''
  const rows = chunk.slice(wipe[0].length).split('\n')

  return `${climb}${COLUMN_ZERO}${rows.map((row) => row + ERASE_RIGHT).join('\n')}${ERASE_BELOW}`
}

/**
 * The terminal, as something to hand to Ink: it answers for the real one and
 * rewrites what Ink writes on the way through.
 */
export function paintOver(stdout: WriteStream): WriteStream {
  const write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    return (stdout.write as (...args: unknown[]) => boolean)(repaint(text), ...rest)
  }
  return new Proxy(stdout, {
    get(target, property) {
      if (property === 'write') return write
      const value = Reflect.get(target, property, target)
      // Methods run against the real stream, so its listeners and its buffers
      // are the ones that change; values such as `rows` are read from it.
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as WriteStream
}
