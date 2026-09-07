/** At most limit events per key in any windowMs-long span. */
export class SlidingWindow {
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    throw new Error(`SlidingWindow.allow is not implemented yet (${key})`)
  }

  remaining(key: string): number {
    throw new Error(`SlidingWindow.remaining is not implemented yet (${key})`)
  }
}
