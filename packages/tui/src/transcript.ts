import { fold } from './components/text-width.ts'

/**
 * Turning what an agent said into rows of a fixed-height pane.
 *
 * A message is not a row. Models answer in paragraphs, with line breaks and
 * lists inside one message, and a pane that assumes one message is one row
 * miscounts its own height: the surplus is drawn past the bottom edge, over
 * whatever was there. Folding first is what makes the arithmetic true.
 */

export type Kind = 'ask' | 'say' | 'tool' | 'error' | 'note' | 'thinking'

export type Entry = {
  kind: Kind
  text: string
}

export type VisualRow = {
  kind: Kind
  text: string
  /** False for the rows a message spills onto, which carry no marker. */
  first: boolean
}

/** Columns spent on the marker in front of every row. */
export const MARKER = 2

/**
 * The folding, remembered per message.
 *
 * Folding is cheap for one message and expensive for four thousand, and both
 * counting the pages and drawing a page walk the whole history. Nothing said
 * is ever edited, so a message folded at a given width folds the same way
 * forever — and the entries are the very objects the interface holds, so the
 * cache empties itself when they go.
 */
const folded = new WeakMap<Entry, { width: number; rows: string[] }>()

function rowsOf(entry: Entry, width: number): string[] {
  const kept = folded.get(entry)
  if (kept && kept.width === width) return kept.rows

  const rows = fold(entry.text, width)
  folded.set(entry, { width, rows })
  return rows
}

/**
 * Folds entries to `width` and keeps one pane's worth of rows.
 *
 * `back` is how many pages to go up: zero is the newest, one is the page
 * before it, and so on. Pages rather than free scrolling because a page is a
 * keystroke and a scroll position is a thing you have to steer — and because
 * only the rows being shown are ever folded, so going back through a long
 * session costs the same as staying at the end.
 *
 * A message too tall for the pane loses its beginning rather than its end.
 */
export function toRows(entries: Entry[], width: number, room: number, back = 0): VisualRow[] {
  if (room <= 0) return []

  const inner = Math.max(1, width - MARKER)
  const wanted = room * (Math.max(0, back) + 1)
  const rows: VisualRow[] = []

  // Backwards, stopping as soon as enough has been gathered. Folding the whole
  // history to then throw away all but the last thirty rows was the single
  // most expensive thing the interface did, and it got worse as the session
  // grew.
  for (let at = entries.length - 1; at >= 0 && rows.length < wanted; at--) {
    const entry = entries[at]
    if (!entry) continue
    const lines = rowsOf(entry, inner)
    for (let line = lines.length - 1; line >= 0 && rows.length < wanted; line--) {
      rows.push({ kind: entry.kind, text: lines[line] as string, first: line === 0 })
    }
  }

  rows.reverse()
  // The oldest `room` of what was gathered: on the newest page that is the
  // last rows, and each page back drops one pane's worth off the end.
  return back === 0 ? rows.slice(-room) : rows.slice(0, room)
}

/**
 * How many pages back a pane can go.
 *
 * Counted by folding, which is why it takes a width: the answer changes when
 * the window does, and a page number that outlives its width points at
 * nothing. Bounded so a very long session does not cost a full fold to count.
 */
export function pagesOf(entries: Entry[], width: number, room: number, limit = 200): number {
  if (room <= 0) return 0

  const inner = Math.max(1, width - MARKER)
  let rows = 0

  for (let at = entries.length - 1; at >= 0 && rows < room * limit; at--) {
    const entry = entries[at]
    if (entry) rows += rowsOf(entry, inner).length
  }

  return Math.max(0, Math.ceil(rows / room) - 1)
}
