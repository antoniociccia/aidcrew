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
  throw new Error(`debounce is not implemented yet (${fn.name || 'fn'}, ${ms}ms, ${typeof timers})`)
}
