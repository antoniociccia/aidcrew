/**
 * Reading the mouse.
 *
 * Terminals do not report the mouse unless asked, and then they report it as
 * escape sequences on the same stream as the keyboard. This asks, and turns
 * what comes back into events with coordinates.
 *
 * The SGR encoding is the one to use: the original protocol encodes a
 * coordinate as a single byte, so it silently stops working past column 223 —
 * which any full-screen interface passes.
 */

export type MouseEvent = {
  kind: 'down' | 'up' | 'drag' | 'wheel'
  /** Zero-based, so it indexes a row or a column directly. */
  column: number
  row: number
  button: 'left' | 'middle' | 'right'
  /** For a wheel event: which way it turned. */
  direction?: 'up' | 'down'
}

/** Ask the terminal to report button presses, drags, and use SGR coordinates. */
export const START = '\u001b[?1000h\u001b[?1002h\u001b[?1006h'

/** Stop reporting. Sent on the way out, and on a crash, or the shell inherits it. */
export const STOP = '\u001b[?1006l\u001b[?1002l\u001b[?1000l'

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what this matches
const SGR = /\u001b?\[<(\d+);(\d+);(\d+)([Mm])/g

export function parseMouse(data: string): MouseEvent[] {
  const events: MouseEvent[] = []

  SGR.lastIndex = 0
  for (const match = { current: SGR.exec(data) }; match.current; match.current = SGR.exec(data)) {
    const [, rawButton, rawColumn, rawRow, ending] = match.current
    const code = Number(rawButton)

    // Coordinates arrive one-based; every consumer wants an index.
    const column = Number(rawColumn) - 1
    const row = Number(rawRow) - 1

    if (code >= 64) {
      events.push({
        kind: 'wheel',
        column,
        row,
        button: 'left',
        direction: (code & 1) === 0 ? 'up' : 'down',
      })
      continue
    }

    const button = BUTTONS[code & 3] ?? 'left'
    const moving = (code & 32) !== 0

    events.push({
      kind: ending === 'm' ? 'up' : moving ? 'drag' : 'down',
      column,
      row,
      button,
    })
  }

  return events
}

const BUTTONS = ['left', 'middle', 'right'] as const

/**
 * Whether a chunk from the terminal is mouse reporting rather than typing.
 *
 * The escape is optional on purpose. Ink parses key presses before handing
 * anything on, and a sequence it does not recognise arrives with the escape
 * already eaten — so `[<0;70;3M` turned up inside whatever was being typed the
 * moment anybody clicked. Matched anywhere in the chunk, because a click while
 * typing arrives in the same read as the letter.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what this matches
const REPORT = /\u001b?\[<\d+;\d+;\d+[Mm]/

export function isMouse(data: string): boolean {
  return REPORT.test(data)
}

/** The same chunk with any mouse reporting taken out of it. */
export function withoutMouse(data: string): string {
  return data.replace(new RegExp(REPORT, 'g'), '')
}
