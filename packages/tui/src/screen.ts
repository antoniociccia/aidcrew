/**
 * Taking over the terminal, and giving it back.
 *
 * Ink draws into the normal scrollback by default: the interface becomes part
 * of the shell's history, it grows downwards as content arrives, and every
 * change tall enough to exceed the window redraws the lot — which is the
 * flicker.
 *
 * The alternate screen buffer fixes all three at once. It is the second screen
 * every terminal has had since the seventies, the one vim and less use: the
 * interface owns it entirely, nothing scrolls, and on exit the shell is
 * exactly as it was, with no wall of output left behind.
 */

const ESC = '\u001b'

/** The second screen every terminal has: vim and less use this one. */
const ENTER_ALT_SCREEN = `${ESC}[?1049h`
const LEAVE_ALT_SCREEN = `${ESC}[?1049l`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR = `${ESC}[2J${ESC}[H`

export type Screen = {
  /** Rows available to draw in, minus nothing: the interface owns them all. */
  rows: number
  columns: number
  release(): void
}

export type ScreenOptions = {
  stdout?: NodeJS.WriteStream
  /** Skipped in tests and when output is not a terminal. */
  enabled?: boolean
}

/**
 * Claims the alternate screen, returning something that gives it back.
 *
 * Release is idempotent and wired to the ways a process can end, because a
 * terminal left on the alternate screen looks broken to its owner: their shell
 * is still there, but they cannot see it.
 */
export function claimScreen(options: ScreenOptions = {}): Screen {
  const stdout = options.stdout ?? process.stdout
  const enabled = options.enabled ?? stdout.isTTY === true

  if (!enabled) {
    return { rows: stdout.rows ?? 24, columns: stdout.columns ?? 80, release: () => {} }
  }

  stdout.write(ENTER_ALT_SCREEN + CLEAR + HIDE_CURSOR)

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN)
    for (const [event, handler] of handlers) process.off(event, handler)
  }

  // Every way out, including the ones that skip normal cleanup. A terminal
  // left on the alternate screen is a terminal its owner thinks is broken.
  const handlers: [NodeJS.Signals | 'exit', () => void][] = [
    ['exit', release],
    ['SIGINT', release],
    ['SIGTERM', release],
    ['SIGHUP', release],
  ]
  for (const [event, handler] of handlers) process.on(event, handler)

  return {
    rows: stdout.rows ?? 24,
    columns: stdout.columns ?? 80,
    release,
  }
}
