/**
 * A turn going round in circles, seen while it is still cheap.
 *
 * The turn limit stops a model that is going round in circles — after fifty
 * tool calls, on the bill. Watched on real runs, the circle is visible much
 * sooner: the same command failing the same way, the same file read for the
 * same contents, the same patch put back after being taken out. The harness
 * counts, per turn, how many times one exact call has returned one exact
 * result; the third time it says so in the result, and the sixth it refuses
 * to run the call again. A result that changes is progress, and the count
 * starts over.
 */

/** How many identical results of one call before the harness says so, in the result. */
export const REPEATS_NOTED = 3
/** How many before the call is not run again this turn. */
export const REPEATS_REFUSED = 6

type Streak = { output: string; times: number }

/** Identical calls with identical results, counted for one turn. */
export class Repeats {
  #streaks = new Map<string, Streak>()

  /** Records a result and says how many times running this exact call has now returned it. */
  record(name: string, input: unknown, output: string): number {
    const key = keyOf(name, input)
    const streak = this.#streaks.get(key)
    if (streak && streak.output === output) {
      streak.times += 1
      return streak.times
    }
    this.#streaks.set(key, { output, times: 1 })
    return 1
  }

  /** How many times in a row this exact call has returned the same result. */
  streak(name: string, input: unknown): number {
    return this.#streaks.get(keyOf(name, input))?.times ?? 0
  }
}

function keyOf(name: string, input: unknown): string {
  let args: string
  try {
    args = JSON.stringify(input) ?? ''
  } catch {
    args = String(input)
  }
  return `${name}\u0000${args}`
}

/** What is added to a result that has come back this many times. */
export function saidOnRepeat(times: number): string {
  return (
    `\n\n[harness] This exact call has returned this exact result ${times} times this turn. ` +
    'Running it again will not change it. Change approach: look for different evidence, ' +
    'try a different command, or report what is blocking you.'
  )
}

/** What replaces a call the harness will not run again this turn. */
export function refusedOnRepeat(name: string, times: number): string {
  return (
    `refused by the harness: ${name} has returned the same result ${times} times this turn ` +
    'and will not be run again this turn. Change approach, or report what is blocking you.'
  )
}
