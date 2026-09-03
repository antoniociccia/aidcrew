import { widthOf } from '@aidcrew/fast-width'

/**
 * Cutting and folding text to a width in terminal columns.
 *
 * The measuring itself lives in `@aidcrew/fast-width`, which is a package
 * rather than a file because Ink needs the same function: it calls
 * `string-width` to lay out every row of every frame, and that dependency is
 * patched to hand the work here.
 */

export { widthOf }

/** Whether every character is one column, which is true of most text. */
const PLAIN = /^[\x20-\x7e]*$/

/**
 * Splits `text` at `width` columns, never inside a character.
 *
 * A grapheme that would straddle the edge goes to the remainder whole: half an
 * emoji is not a narrower emoji, it is a broken one.
 */
export function cutAt(text: string, width: number): [string, string] {
  if (width <= 0) return ['', text]
  if (widthOf(text) <= width) return [text, '']
  if (PLAIN.test(text)) return [text.slice(0, width), text.slice(width)]

  let kept = ''
  let used = 0

  for (const { segment } of GRAPHEMES.segment(text)) {
    const size = widthOf(segment)
    if (used + size > width) break
    kept += segment
    used += size
  }

  return [kept, text.slice(kept.length)]
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Breaks text into rows of at most `width` columns.
 *
 * Line breaks in the text are honoured — a model that answers in paragraphs
 * gets paragraphs — and long lines break at a space where there is one, so
 * words survive the fold.
 */
export function fold(text: string, width: number): string[] {
  if (width <= 0) return []

  return text
    .replace(/\t/g, '  ')
    .split(/\r?\n/)
    .flatMap((paragraph) => foldOne(paragraph, width))
}

function foldOne(paragraph: string, width: number): string[] {
  if (paragraph === '') return ['']

  const rows: string[] = []
  let rest = paragraph

  while (widthOf(rest) > width) {
    const [head, tail] = cutAt(rest, width)
    // Prefer the last space in the piece we are keeping, so the break lands
    // between words. A single word longer than the row still has to be cut.
    const space = head.lastIndexOf(' ')
    if (space > 0 && tail !== '' && !tail.startsWith(' ')) {
      rows.push(head.slice(0, space))
      rest = `${head.slice(space + 1)}${tail}`
      continue
    }
    rows.push(head)
    rest = tail.startsWith(' ') ? tail.slice(1) : tail
  }

  rows.push(rest)
  return rows
}
