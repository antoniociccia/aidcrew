export type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type Debounced<A extends unknown[]> = ((...args: A) => void) & {
  cancel: () => void
  flush: () => void
}

const GLOBAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** A version of fn that runs once, ms after the most recent call. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  timers: Timers = GLOBAL_TIMERS,
): Debounced<A> {
  if (!(ms >= 0)) throw new RangeError(`ms must be 0 or more, got ${ms}`)
  let handle: unknown
  let pending: A | undefined
  const run = () => {
    handle = undefined
    if (pending === undefined) return
    const args = pending
    pending = undefined
    fn(...args)
  }
  const debounced = ((...args: A) => {
    pending = args
    if (handle !== undefined) timers.clearTimeout(handle)
    handle = timers.setTimeout(run, ms)
  }) as Debounced<A>
  debounced.cancel = () => {
    if (handle !== undefined) timers.clearTimeout(handle)
    handle = undefined
    pending = undefined
  }
  debounced.flush = () => {
    if (handle !== undefined) timers.clearTimeout(handle)
    run()
  }
  return debounced
}
