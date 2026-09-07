export type RetryOptions = {
  attempts: number
  baseMs: number
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** fn's first result, trying again after a failure, with the waits growing. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new RangeError(`attempts must be 1 or more, got ${options.attempts}`)
  }
  const sleep = options.sleep ?? realSleep
  let last: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn()
    } catch (cause) {
      last = cause
      if (attempt < options.attempts) await sleep(options.baseMs * 2 ** (attempt - 1))
    }
  }
  const message = last instanceof Error ? last.message : String(last)
  throw new Error(`gave up after ${options.attempts} attempts: ${message}`, { cause: last })
}
