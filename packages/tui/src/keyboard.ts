import { PassThrough } from 'node:stream'

/**
 * The keys a terminal will not send, put back before anything reads them.
 *
 * On several European layouts the characters a programmer types constantly —
 * `@`, `#`, `[`, `]` — need the option key. A terminal set to treat option as
 * meta then sends an escape and the *unshifted* letter rather than the
 * character: option-ò arrives as `\x1b` then `ò`, and the `@` never arrives at
 * all. Measured with `aidcrew keys`, which exists because guessing at this
 * twice was twice too many.
 *
 * It has to be fixed here, on the bytes, because Ink discards the escape
 * before a component sees it: option-ò and a plain ò both arrive as `ò` with
 * no modifier set, and by then they are the same keystroke. `\x1bb` keeps its
 * meta flag, because `b` is ASCII — which is exactly why only the accented
 * letters need this and why mapping a plain letter would be wrong: alt-b and
 * alt-f move by word in every shell there is.
 */

/** What each key is printed with, where the terminal sends what is under it. */
const PRINTED_ON: Record<string, string> = {
  ò: '@',
  à: '#',
  è: '[',
  é: ']',
  ì: '^',
  ù: '§',
}

const ESC = ''

/**
 * Rewrites a chunk of terminal input.
 *
 * Only an escape immediately followed by one of those letters. Everything
 * else, including an escape on its own and every other escape sequence — the
 * arrows, the mouse, the page keys — passes through untouched, because
 * touching them is how a keyboard fix becomes a broken mouse.
 */
export function putBackKeys(chunk: string): string {
  if (!chunk.includes(ESC)) return chunk

  let out = ''
  for (let at = 0; at < chunk.length; at += 1) {
    const here = chunk[at] as string
    const next = chunk[at + 1]

    if (here === ESC && next !== undefined && PRINTED_ON[next] !== undefined) {
      out += PRINTED_ON[next]
      at += 1
      continue
    }
    out += here
  }
  return out
}

/**
 * The same, as a stream to hand to Ink in place of stdin.
 *
 * A pass-through rather than a listener on the real stdin: Ink 7 reads with
 * `readable` and `read()`, and a second reader on the same stream races it for
 * the bytes — a click swallowing a keystroke, which happened once already and
 * took a while to find.
 */
export function fixedKeyboard(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  if (stdin.isTTY !== true) return stdin

  const out = new PassThrough({ encoding: 'utf8' })
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => out.write(putBackKeys(chunk)))

  // Everything Ink asks of a stdin, forwarded to the real one. A stream is not
  // a TTY and has none of these: leaving out `ref` alone crashed the whole
  // interface on the first render with "I.ref is not a function", which is
  // what happens when a wrapper is written from what it seemed to need rather
  // than from what the thing it replaces provides.
  const fixed = out as unknown as NodeJS.ReadStream
  fixed.isTTY = true
  fixed.setRawMode = (on: boolean) => {
    stdin.setRawMode(on)
    return fixed
  }
  fixed.ref = () => {
    stdin.ref()
    return fixed
  }
  fixed.unref = () => {
    stdin.unref()
    return fixed
  }

  return fixed
}
