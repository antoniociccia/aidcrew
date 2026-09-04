/**
 * Leaving when the terminal does.
 *
 * Listening for a signal replaces its default, and for SIGHUP the default
 * was the exit. The interface listened so it could close the store and give
 * the screen back — and then nothing ended the process, so a closed window
 * left aidcrew running in the background with its session and its checkouts
 * for as long as the machine stayed up. Three were found the same afternoon,
 * sharing a project with the one that was actually on screen.
 *
 * So the listener closes what it holds and then does what the default would
 * have done, with the exit code the shell expects for that signal.
 */

type Signals = 'SIGHUP' | 'SIGINT' | 'SIGTERM'

/** What a process killed by each signal reports, by convention: 128 plus its number. */
const EXIT_CODE: Record<Signals, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

type Process = {
  once(signal: Signals, handler: () => void): unknown
  off(signal: Signals, handler: () => void): unknown
  exit(code: number): never | void
}

/**
 * Closes and exits on any of the three signals. Returns the way to stop
 * listening, for the ordinary exit that has already closed everything.
 */
export function leaveOnSignal(proc: Process, close: () => void): () => void {
  const handlers = (Object.keys(EXIT_CODE) as Signals[]).map((signal) => {
    const handler = () => {
      close()
      proc.exit(EXIT_CODE[signal])
    }
    proc.once(signal, handler)
    return [signal, handler] as const
  })

  return () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler)
  }
}
