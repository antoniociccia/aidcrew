export type RetryOptions = {
  attempts: number
  baseMs: number
  sleep?: (ms: number) => Promise<void>
}

/** fn's first result, trying again after a failure, with the waits growing. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  throw new Error(`retry is not implemented yet (${options.attempts} attempts, ${fn.name || 'fn'})`)
}
