/** A token bucket: a burst up to capacity, then a steady rate. */
export class RateLimiter {
  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    readonly now: () => number = () => Date.now(),
  ) {}

  /** Takes n tokens if they are there; takes nothing otherwise. */
  tryTake(n = 1): boolean {
    throw new Error(`RateLimiter.tryTake is not implemented yet (asked for ${n})`)
  }

  /** The tokens in the bucket right now, refilled up to the current time. */
  get available(): number {
    throw new Error('RateLimiter.available is not implemented yet')
  }
}
