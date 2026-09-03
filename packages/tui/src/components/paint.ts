import type { Segment } from './row.ts'

/**
 * Painting rows into one string the terminal can take as it is.
 *
 * Ink lays out every element with a flexbox engine, which is the right thing
 * for a form and the wrong thing for a wall of text: a screen of agent output
 * is some five hundred nodes, and measuring them cost about seven milliseconds
 * per keystroke. Composing the same rows here and handing Ink one string costs
 * two tenths of one. Ink still owns the layout of the screen — the regions,
 * the header, the prompt — it just stops being asked to lay out the inside of
 * a paragraph.
 *
 * The escape codes are the ones Ink would emit. Nothing here draws anywhere:
 * the string is returned, and Ink puts it where it belongs.
 */

export type PaintedRow = {
  /** The ground for segments that do not name one of their own. */
  background?: string | undefined
  segments: Segment[]
}

const ESC = '\u001b'

/** How much colour the terminal can read. */
export type Depth = 'truecolor' | 'ansi256' | 'none'

/**
 * What the terminal can actually take.
 *
 * Every distinction this interface draws is carried by colour — whose pane
 * this is, which tab is live, what is running — and all of it used to go out
 * as 24-bit escapes whatever the terminal claimed. One that cannot read them
 * prints the code or drops it, and the meaning goes with it.
 *
 * Downgraded only on positive evidence. Silence is not evidence: most
 * terminals say nothing and most terminals can take 24 bits, so assuming the
 * worst would strip the colour from the machines that had it.
 *
 * `NO_COLOR` is the convention; `FORCE_COLOR=0` is what tooling sets. Both are
 * honoured so the layout previews and the tests can read what they produce.
 */
export function depthOf(env: Record<string, string | undefined>): Depth {
  if (env.NO_COLOR !== undefined || env.FORCE_COLOR === '0') return 'none'
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor'
  if (env.TERM?.includes('256color') === true) return 'ansi256'
  return 'truecolor'
}

export function paint(
  rows: PaintedRow[],
  env: Record<string, string | undefined> = process.env,
): string {
  const depth = depthOf(env)
  if (depth === 'none') {
    return rows.map((row) => row.segments.map((segment) => segment.text).join('')).join('\n')
  }

  return rows.map((row) => paintRow(row, depth)).join('\n')
}

/** What the terminal is currently set to, so only changes are written. */
type Pen = {
  ground: string | undefined
  colour: string | undefined
  bold: boolean
}

function paintRow(row: PaintedRow, depth: Depth): string {
  const pen: Pen = { ground: undefined, colour: undefined, bold: false }
  let out = ''

  for (const segment of row.segments) {
    out += switchTo(segment, row.background, pen, depth) + segment.text
  }

  // Ink calls trimEnd on every line, so a row that ends in bare spaces loses
  // them. That is harmless: a row with nothing painted at its right edge has
  // nothing to lose. A row that does paint there ends with these closing
  // codes, which are not whitespace, so its padding survives.
  return out + close(pen)
}

/**
 * The codes needed to reach a segment's styling from where the pen is.
 *
 * Only what changed: a row is mostly runs of the same styling, and repeating
 * every code for every segment multiplies what goes down the pipe for no
 * visible difference.
 */
function switchTo(segment: Segment, rowGround: string | undefined, pen: Pen, depth: Depth): string {
  let out = ''

  const ground = segment.background ?? rowGround
  if (ground !== pen.ground) {
    out += ground ? `${ESC}[${ink(48, ground, depth)}m` : `${ESC}[49m`
    pen.ground = ground
  }

  // Compared as a boolean: an absent `bold` and an explicit `false` mean the
  // same thing, and treating them as different emitted a code per segment.
  const bold = segment.bold === true
  if (bold !== pen.bold) {
    out += bold ? `${ESC}[1m` : `${ESC}[22m`
    pen.bold = bold
  }

  if (segment.color !== pen.colour) {
    out += segment.color ? `${ESC}[${ink(38, segment.color, depth)}m` : `${ESC}[39m`
    pen.colour = segment.color
  }

  return out
}

/**
 * One colour, in the deepest form this terminal admits to reading.
 *
 * `role` is 38 for the text and 48 for the ground, which is the only thing
 * that differs between the two escapes.
 */
function ink(role: 38 | 48, hex: string, depth: Depth): string {
  return depth === 'truecolor' ? `${role};2;${rgb(hex)}` : `${role};5;${indexOf(hex)}`
}

/**
 * Back to plain at the end of every row.
 *
 * Styling that leaks past a newline paints whatever the terminal draws next,
 * which is not ours to touch.
 */
function close(pen: Pen): string {
  return (
    (pen.bold ? `${ESC}[22m` : '') +
    (pen.colour ? `${ESC}[39m` : '') +
    (pen.ground ? `${ESC}[49m` : '')
  )
}

/** `#rrggbb` as the decimal triple a truecolor escape wants. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
}

/**
 * The xterm-256 entry closest to a colour.
 *
 * Two palettes live in that space and picking the wrong one is what makes a
 * downgraded theme look muddy. 16-231 is a 6x6x6 cube whose steps are uneven
 * and coarse; 232-255 is a 24-step grey ramp, much finer than the cube's own
 * greys. So a colour with almost no saturation goes to the ramp — which is
 * most of this interface's grounds and rules — and anything that is actually a
 * colour stays in the cube, where the hue survives even though the shade does
 * not. Deciding by saturation rather than by r===g===b matters because the
 * tints are voices mixed into a ground, and land a step or two off neutral.
 */
export function indexOf(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255

  const high = Math.max(r, g, b)
  const low = Math.min(r, g, b)

  if (high - low <= GREY_SPREAD) {
    const level = Math.round((r + g + b) / 3)
    // The ramp runs 8..238 in steps of ten and does not reach either end, so
    // black and white come from the cube, which has both exactly.
    if (level < 8) return 16
    if (level > 238) return 231
    return 232 + Math.round((level - 8) / 10)
  }

  return 16 + 36 * step(r) + 6 * step(g) + step(b)
}

/** How far apart the channels may be and still read as grey rather than colour. */
const GREY_SPREAD = 10

/** The cube's six levels are 0, 95, 135, 175, 215, 255 — not evenly spaced. */
const LEVELS = [0, 95, 135, 175, 215, 255] as const

function step(channel: number): number {
  let best = 0
  for (const [at, level] of LEVELS.entries()) {
    if (Math.abs(level - channel) < Math.abs((LEVELS[best] ?? 0) - channel)) best = at
  }
  return best
}
