/**
 * What a change did, line by line.
 *
 * An agent that writes a file reports `wrote src/rates.ts (412 bytes)`, which
 * is all the model needs and nothing a person can judge. This works out the
 * difference so the interface can show it — and so the guard can put one part
 * of it back, and the radar can say which lines are being fought over.
 *
 * Kept here rather than in the guard because the tool that made the change is
 * the one that knows what it changed; the guard's snapshot is an
 * implementation detail of undo, and somebody who turns the guards off still
 * wants to see the work.
 */

/** Lines either side of a change, so a hunk reads as part of a file. */
const CONTEXT = 2

/**
 * Changes nearer than this are one hunk.
 *
 * Twice the context: any closer and the two hunks' context would overlap, and
 * printing the same line twice under two headings reads as two changes to it.
 */
const TOGETHER = CONTEXT * 2

/**
 * Rows one change may take on screen.
 *
 * Three panes side by side are about twenty-five columns and twenty rows
 * each. A change that fills the pane is a change that hides the conversation
 * it belongs to, so the rest is a count — the file has the whole of it.
 */
const MAX_ROWS = 12

export type Hunk = {
  /** 1-based first line on the old side; 0 when the hunk only adds. */
  oldStart: number
  oldLines: string[]
  /** 1-based first line on the new side; 0 when the hunk only removes. */
  newStart: number
  newLines: string[]
}

export type FileChange = {
  path: string
  added: number
  removed: number
  hunks: Hunk[]
  /** Whether there was nothing there before. */
  created: boolean
}

/**
 * The difference between two versions of a file, or nothing when they match.
 *
 * `undefined` rather than an empty change on purpose: every caller's next
 * question is "was there anything to show", and an object that has to be
 * interrogated for it is one `if` in every caller.
 */
export function changeOf(path: string, before: string, after: string): FileChange | undefined {
  const { hunks, added, removed } = hunksOf(linesOf(before), linesOf(after))
  if (hunks.length === 0) return undefined

  return { path, added, removed, hunks, created: before === '' }
}

/**
 * The change as rows, each one beginning with what it is.
 *
 * `~` heading, `+` added, `-` removed, a space for context, `…` for what did
 * not fit. The marker leads so that painting a row is reading one character:
 * anything else means the interface and this file agreeing on a column, and
 * that agreement breaks the first time a line number reaches five digits.
 */
export function render(change: FileChange): string {
  const rows = [`~ ${change.path} +${change.added} -${change.removed}`]
  let left = MAX_ROWS
  let elided = 0

  for (const hunk of change.hunks) {
    for (const row of rowsOf(hunk)) {
      if (left === 0) {
        elided += 1
        continue
      }
      rows.push(row)
      left -= 1
    }
  }

  if (elided > 0) rows.push(`… +${elided} more lines`)
  return rows.join('\n')
}

/**
 * The lines of the new file each hunk covers, for whoever is watching for two
 * agents in the same place.
 *
 * A hunk that only removes still names where it happened: the collision is
 * about the region, and a deletion at line 40 collides with a rewrite of line
 * 40 exactly as an edit would.
 */
export function rangesOf(change: FileChange): [number, number][] {
  return change.hunks.map((hunk) => {
    const start = Math.max(1, hunk.newStart)
    return [start, Math.max(start, start + hunk.newLines.length - 1)]
  })
}

function rowsOf(hunk: Hunk): string[] {
  const rows: string[] = []
  const common = leading(hunk)
  const tail = trailing(hunk, common)

  for (let at = 0; at < common; at += 1) {
    rows.push(`  ${hunk.newStart + at} ${clean(hunk.newLines[at] ?? '')}`)
  }
  for (let at = common; at < hunk.oldLines.length - tail; at += 1) {
    rows.push(`- ${hunk.oldStart + at} ${clean(hunk.oldLines[at] ?? '')}`)
  }
  for (let at = common; at < hunk.newLines.length - tail; at += 1) {
    rows.push(`+ ${hunk.newStart + at} ${clean(hunk.newLines[at] ?? '')}`)
  }
  for (let at = hunk.newLines.length - tail; at < hunk.newLines.length; at += 1) {
    rows.push(`  ${hunk.newStart + at} ${clean(hunk.newLines[at] ?? '')}`)
  }

  return rows
}

/** How many lines at the start of a hunk are the same on both sides. */
function leading(hunk: Hunk): number {
  let at = 0
  while (at < hunk.oldLines.length && at < hunk.newLines.length) {
    if (hunk.oldLines[at] !== hunk.newLines[at]) break
    at += 1
  }
  return at
}

/** The same at the end, without eating into what `leading` already claimed. */
function trailing(hunk: Hunk, common: number): number {
  let at = 0
  const room = Math.min(hunk.oldLines.length, hunk.newLines.length) - common
  while (at < room) {
    const old = hunk.oldLines[hunk.oldLines.length - 1 - at]
    const now = hunk.newLines[hunk.newLines.length - 1 - at]
    if (old !== now) break
    at += 1
  }
  return at
}

/**
 * A carriage return at the end of a line is not part of it.
 *
 * On a file with Windows endings every row would otherwise carry a control
 * character into a terminal that is drawing a row at a time.
 */
function clean(line: string): string {
  return line.replace(/\r$/, '')
}

/**
 * A file as lines, with no phantom last one.
 *
 * A trailing newline terminates the last line, it does not start an empty
 * one — the same reasoning as `read`, and the same bug avoided.
 */
export function linesOf(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

type Op = { kind: 'same' | 'add' | 'del'; old: number; now: number }

/**
 * Where the two versions differ, gathered into hunks with their context.
 *
 * The counts come from here rather than from the hunks, because a hunk holds
 * its context as well as its change: adding up its lines would report the
 * four unchanged ones around a one-line edit as four more edits.
 */
function hunksOf(
  old: string[],
  now: string[],
): {
  hunks: Hunk[]
  added: number
  removed: number
} {
  const ops = opsOf(old, now)
  const changed = ops.flatMap((op, at) => (op.kind === 'same' ? [] : [at]))
  if (changed.length === 0) return { hunks: [], added: 0, removed: 0 }

  const added = ops.filter((op) => op.kind === 'add').length
  const removed = ops.filter((op) => op.kind === 'del').length

  // Runs of changed operations, joined when what separates them is shorter
  // than the context either side would print anyway.
  const runs: [number, number][] = []
  for (const at of changed) {
    const last = runs.at(-1)
    if (last && at - last[1] <= TOGETHER) last[1] = at
    else runs.push([at, at])
  }

  const hunks = runs.map(([from, to]) => {
    const start = Math.max(0, from - CONTEXT)
    const end = Math.min(ops.length - 1, to + CONTEXT)
    const within = ops.slice(start, end + 1)

    const oldLines = within.filter((op) => op.kind !== 'add').map((op) => old[op.old] ?? '')
    const newLines = within.filter((op) => op.kind !== 'del').map((op) => now[op.now] ?? '')
    const firstOld = within.find((op) => op.kind !== 'add')
    const firstNew = within.find((op) => op.kind !== 'del')

    return {
      oldStart: firstOld === undefined ? 0 : firstOld.old + 1,
      oldLines,
      newStart: firstNew === undefined ? 0 : firstNew.now + 1,
      newLines,
    }
  })

  return { hunks, added, removed }
}

/**
 * Beyond this many lines either side, the difference is not worked out.
 *
 * The table below is one cell per pair of lines. At a thousand lines each way
 * that is a million cells, which is a millisecond or two; at a hundred
 * thousand it is ten billion, which is the interface stopping. A file that
 * large is not read on screen anyway, so it is reported as one block.
 */
const TOO_BIG = 4_000_000

function opsOf(old: string[], now: string[]): Op[] {
  // The ends usually match, and trimming them first is what keeps the table
  // small for the ordinary case: one line changed in a file of two thousand.
  let head = 0
  while (head < old.length && head < now.length && old[head] === now[head]) head += 1

  let tail = 0
  while (
    tail < old.length - head &&
    tail < now.length - head &&
    old[old.length - 1 - tail] === now[now.length - 1 - tail]
  ) {
    tail += 1
  }

  const oldMiddle = old.slice(head, old.length - tail)
  const nowMiddle = now.slice(head, now.length - tail)

  const ops: Op[] = []
  for (let at = 0; at < head; at += 1) ops.push({ kind: 'same', old: at, now: at })

  for (const op of middleOps(oldMiddle, nowMiddle, head)) ops.push(op)

  for (let at = 0; at < tail; at += 1) {
    ops.push({
      kind: 'same',
      old: old.length - tail + at,
      now: now.length - tail + at,
    })
  }

  return ops
}

function middleOps(old: string[], now: string[], from: number): Op[] {
  if (old.length === 0 && now.length === 0) return []
  if (old.length === 0) return additions(now, from)
  if (now.length === 0) return removals(old, from)
  // Past the bound, the whole middle is reported as gone and rewritten. It is
  // the truthful answer to "what changed" when working out the finer one
  // would cost more than the screen it is drawn on.
  if (old.length * now.length > TOO_BIG) return [...removals(old, from), ...additions(now, from)]

  return walk(old, now, from, lcsTable(old, now))
}

function additions(lines: string[], from: number): Op[] {
  return lines.map((_, at) => ({ kind: 'add', old: -1, now: from + at }) as Op)
}

function removals(lines: string[], from: number): Op[] {
  return lines.map((_, at) => ({ kind: 'del', old: from + at, now: -1 }) as Op)
}

/**
 * Longest common subsequence lengths, filled backwards.
 *
 * Backwards so that the walk forwards can choose between dropping a line and
 * adding one by reading the two cells ahead of it, without looking any
 * further. One flat array rather than an array of arrays: the table is the
 * hot part of this file, and a row lookup per cell was most of its cost.
 */
function lcsTable(old: string[], now: string[]): { cells: Int32Array; width: number } {
  const width = now.length + 1
  const cells = new Int32Array((old.length + 1) * width)

  for (let a = old.length - 1; a >= 0; a -= 1) {
    for (let b = now.length - 1; b >= 0; b -= 1) {
      cells[a * width + b] =
        old[a] === now[b]
          ? (cells[(a + 1) * width + b + 1] ?? 0) + 1
          : Math.max(cells[(a + 1) * width + b] ?? 0, cells[a * width + b + 1] ?? 0)
    }
  }

  return { cells, width }
}

function walk(
  old: string[],
  now: string[],
  from: number,
  table: { cells: Int32Array; width: number },
): Op[] {
  const { cells, width } = table
  const ops: Op[] = []
  let a = 0
  let b = 0

  while (a < old.length && b < now.length) {
    if (old[a] === now[b]) {
      ops.push({ kind: 'same', old: from + a, now: from + b })
      a += 1
      b += 1
      continue
    }
    // The removal first when the two are worth the same, so a replaced line
    // reads as the old one struck out and the new one under it.
    if ((cells[(a + 1) * width + b] ?? 0) >= (cells[a * width + b + 1] ?? 0)) {
      ops.push({ kind: 'del', old: from + a, now: -1 })
      a += 1
    } else {
      ops.push({ kind: 'add', old: -1, now: from + b })
      b += 1
    }
  }

  return [...ops, ...removals(old.slice(a), from + a), ...additions(now.slice(b), from + b)]
}
