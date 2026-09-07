/** Runs jobs one after another, in the order they were pushed. */
export class Queue {
  readonly errors: Error[] = []
  #pending: Promise<void>[] = []

  push(job: () => Promise<void>): void {
    this.#pending.push(
      job().catch((cause: unknown) => {
        this.errors.push(cause instanceof Error ? cause : new Error(String(cause)))
      }),
    )
  }

  /** Resolves once every job pushed so far has finished. */
  async drain(): Promise<void> {
    await Promise.all(this.#pending)
    this.#pending = []
  }
}
