/**
 * How often a question worth asking is worth asking again.
 *
 * What is left of a plan changes when a turn ends, so a turn ending is the
 * moment to ask — but a team of five ending turns together would ask five
 * times in one second for one answer, and the service is entitled to be asked
 * once. The first goes straight through, because the whole point is that the
 * figure moves while somebody is watching it; the rest wait out the gap.
 */
export type Gate = {
  /** Milliseconds to wait before asking again, or zero to go now. */
  wait(now: number): number
  /** Records that a question actually went out. */
  passed(now: number): void
}

export function refreshGate(everyMs: number): Gate {
  let last: number | undefined

  return {
    wait(now) {
      if (last === undefined) return 0
      return Math.max(0, last + everyMs - now)
    },
    passed(now) {
      last = now
    },
  }
}
