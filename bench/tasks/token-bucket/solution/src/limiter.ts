/** A token bucket: a burst up to capacity, then a steady rate. */
export class RateLimiter {
  #tokens: number
  #refilledAt: number

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    readonly now: () => number = () => Date.now(),
  ) {
    this.#tokens = capacity
    this.#refilledAt = now()
  }

  /** Takes n tokens if they are there; takes nothing otherwise. */
  tryTake(n = 1): boolean {
    if (n > this.capacity) return false
    this.#refill()
    if (this.#tokens < n) return false
    this.#tokens -= n
    return true
  }

  /** The tokens in the bucket right now, refilled up to the current time. */
  get available(): number {
    this.#refill()
    return this.#tokens
  }

  #refill(): void {
    const at = this.now()
    const elapsed = Math.max(0, at - this.#refilledAt) / 1000
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsed * this.refillPerSecond)
    this.#refilledAt = at
  }
}
