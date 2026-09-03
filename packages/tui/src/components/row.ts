/**
 * Composing one line of a tinted surface.
 *
 * Ink paints a background only where characters are, and only inside a `Text`
 * — a `Box` with a background colour comes out empty. So an area that belongs
 * to one agent has to be built a row at a time, each padded to the full width,
 * with the tint carried by the trailing spaces. This is that arithmetic, kept
 * out of the components so it can be checked without rendering anything.
 */

import { cutAt, widthOf } from './text-width.ts'

export type Segment = {
  text: string
  color?: string
  bold?: boolean
  /** Overrides the row's ground, which is how several tabs share one row. */
  background?: string
}

/**
 * Fits `left` and `right` into `width`, pushing them apart.
 *
 * When they do not both fit, the left side loses characters: it is the part
 * that repeats down a column, while the right carries the numbers that differ.
 */
export function compose(width: number, left: Segment[], right: Segment[] = []): Segment[] {
  if (width <= 0) return []

  const rightWidth = measure(right)
  const room = Math.max(0, width - rightWidth)
  const fitted = clip(left.map(flatten), room)
  const gap = room - measure(fitted)

  return [
    ...fitted,
    ...(gap > 0 ? [{ text: ' '.repeat(gap) }] : []),
    ...(rightWidth > width ? clip(right.map(flatten), width) : right.map(flatten)),
  ]
}

/**
 * Strips the characters that would end the row early.
 *
 * A row is one row. Text from a model carries line breaks, and one arriving in
 * a header cell turned it into two — which pushed the cell below out of
 * alignment and spilled it across the neighbouring agents. Control characters
 * are dropped for the same reason: a stray escape sequence would repaint parts
 * of the screen that are not ours.
 */
function flatten(segment: Segment): Segment {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const text = segment.text.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '')
  return text === segment.text ? segment : { ...segment, text }
}

/** Total printed width of a row's segments, in terminal columns. */
export function measure(segments: Segment[]): number {
  return segments.reduce((total, segment) => total + widthOf(segment.text), 0)
}

/**
 * Cuts a row down to `width`, ending in an ellipsis when anything was lost.
 *
 * Truncating in the middle of a word is fine; truncating without saying so is
 * not, because a path that is one character short reads as a different path.
 */
export function clip(segments: Segment[], width: number): Segment[] {
  if (width <= 0) return []
  if (measure(segments) <= width) return segments

  const out: Segment[] = []
  let left = width - 1

  for (const segment of segments) {
    const size = widthOf(segment.text)
    if (size <= left) {
      out.push(segment)
      left -= size
      continue
    }
    const [kept] = cutAt(segment.text, left)
    if (kept !== '') out.push({ ...segment, text: kept })
    left = 0
    break
  }

  out.push({ text: '…' })
  return out
}

/**
 * Cuts a composed row in two at a character position.
 *
 * Used to fill part of a row's background and not the rest: a share of the
 * work drawn as how far the colour reaches, rather than as a bar taking a row
 * of its own. A segment straddling the cut is split, keeping its colour on
 * both sides.
 */
export function split(segments: Segment[], at: number): [Segment[], Segment[]] {
  if (at <= 0) return [[], segments]

  const before: Segment[] = []
  const after: Segment[] = []
  let left = at

  for (const segment of segments) {
    if (left <= 0) {
      after.push(segment)
      continue
    }
    const size = widthOf(segment.text)
    if (size <= left) {
      before.push(segment)
      left -= size
      continue
    }
    const [head, tail] = cutAt(segment.text, left)
    if (head !== '') before.push({ ...segment, text: head })
    if (tail !== '') after.push({ ...segment, text: tail })
    left = 0
  }

  return [before, after]
}

/**
 * Merges neighbouring segments that look the same.
 *
 * Each segment becomes an element the renderer has to lay out and diff, and a
 * padded row is mostly runs of identical styling — the label, then the gap,
 * then the padding. Joining them cuts the work per row without changing a
 * single character of what is drawn.
 */
export function coalesce(segments: Segment[]): Segment[] {
  const out: Segment[] = []

  for (const segment of segments) {
    if (segment.text === '') continue
    const last = out.at(-1)
    if (
      last &&
      last.color === segment.color &&
      last.bold === segment.bold &&
      last.background === segment.background
    ) {
      last.text += segment.text
      continue
    }
    out.push({ ...segment })
  }

  return out
}
