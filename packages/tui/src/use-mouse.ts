import { useInput, useStdout } from 'ink'
import { useEffect, useRef } from 'react'
import type { MouseEvent } from './mouse.ts'
import { parseMouse, START, STOP } from './mouse.ts'

/**
 * Mouse reporting, for as long as the interface is on screen.
 *
 * The events are read through Ink's own input rather than a second listener on
 * stdin. Ink 7 pulls from the stream with `readable` and `read()`; attaching a
 * `data` listener alongside it puts the stream into flowing mode and the two
 * of them then race for the same bytes — so a click could swallow a keystroke,
 * and did.
 *
 * Reporting is turned off again on the way out, and on the way out of the
 * process however that happens: a terminal left in reporting mode prints
 * escape sequences into the shell every time the mouse moves, and the only way
 * back is to reset it by hand.
 *
 * It can also be switched off while the interface is still up, and has to be:
 * a terminal reporting the mouse hands every drag to the program, so selecting
 * text to copy it does nothing at all. There is no way to have both — the
 * choice belongs to whoever is trying to copy something.
 */
export function useMouse(onEvent: (event: MouseEvent) => void, enabled = true): void {
  const { stdout } = useStdout()

  // Held in a ref so a changing handler does not re-run the effect, which
  // would turn reporting off and on again on every render.
  const handler = useRef(onEvent)
  handler.current = onEvent

  // Switched on once and left on for the life of the screen. Turning it on and
  // off as the interface changed wrote escape sequences straight to stdout in
  // the middle of a frame Ink was composing, and the display came apart.
  useEffect(() => {
    if (!enabled) {
      stdout.write(STOP)
      return
    }

    stdout.write(START)
    const stop = (): void => {
      stdout.write(STOP)
    }
    process.once('exit', stop)

    return () => {
      process.off('exit', stop)
      stop()
    }
  }, [stdout, enabled])

  useInput(
    (input) => {
      // Ink hands on what it did not recognise, with the escape already eaten,
      // which is why the parser does not insist on one.
      for (const event of parseMouse(input)) handler.current(event)
    },
    { isActive: enabled },
  )
}
