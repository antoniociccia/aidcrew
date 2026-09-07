/** Runs jobs one after another, in the order they were pushed. */
export class Queue {
  readonly errors: Error[] = []
  #tail: Promise<void> = Promise.resolve()
  #inFlight = 0

  push(job: () => Promise<void>): void {
    this.#inFlight += 1
    this.#tail = this.#tail
      .then(job)
      .catch((cause: unknown) => {
        this.errors.push(cause instanceof Error ? cause : new Error(String(cause)))
      })
      .finally(() => {
        this.#inFlight -= 1
      })
  }

  /** Resolves once every job pushed so far has finished. */
  async drain(): Promise<void> {
    while (this.#inFlight > 0) await this.#tail
  }
}
