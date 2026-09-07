/** At most limit events per key in any windowMs-long span. */
export class SlidingWindow {
  #events = new Map<string, number[]>()

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly now: () => number = () => Date.now(),
  ) {
    if (!(limit >= 1)) throw new RangeError(`limit must be 1 or more, got ${limit}`)
    if (!(windowMs >= 1)) throw new RangeError(`windowMs must be 1 or more, got ${windowMs}`)
  }

  allow(key: string): boolean {
    const live = this.#live(key)
    if (live.length >= this.limit) return false
    live.push(this.now())
    return true
  }

  remaining(key: string): number {
    return this.limit - this.#live(key).length
  }

  #live(key: string): number[] {
    const since = this.now() - this.windowMs
    const live = (this.#events.get(key) ?? []).filter((at) => at > since)
    this.#events.set(key, live)
    return live
  }
}
