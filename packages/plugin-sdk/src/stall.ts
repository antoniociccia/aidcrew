import { ProviderResponseError } from '@aidcrew/core'

/**
 * A clock on a request, so that a service which stops talking is given up on.
 *
 * There was no timeout anywhere. A stalled upstream — headers sent, then
 * nothing, the socket never closed — held an agent's turn for twenty-three
 * minutes in a real run, with a spinner on the screen and nothing else. No
 * error was ever going to arrive, because nothing was wrong that a network
 * stack could see; the connection was open and simply carrying no bytes.
 *
 * Two limits rather than one, because the two silences mean different
 * things. Before the first byte a model may genuinely be reading a long
 * prompt, and a couple of minutes is normal on a busy service. Once it is
 * talking, tokens arrive many times a second, and a minute with none is a
 * connection that has died without saying so. Both are measured as "no
 * bytes for this long" — never as a total, since a long answer is exactly
 * what an agent writing code produces.
 */
export type StallTimeouts = {
  /** How long the service has to send the first byte of its answer. */
  firstByteMs: number
  /** How long it may then go quiet between two chunks. */
  idleMs: number
}

export const DEFAULT_STALL_TIMEOUTS: StallTimeouts = { firstByteMs: 120_000, idleMs: 60_000 }

export type StallWatch = {
  /**
   * The signal to hand to fetch: the caller's own, plus the clock. Aborting
   * the request is what actually frees the socket; the error thrown from
   * `body` is only the report of it.
   */
  signal: AbortSignal
  /** The body, with every chunk resetting the clock and a stall ending it. */
  body(stream: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>
  /**
   * What to throw for a failure: the stall's own error if the clock ran out,
   * otherwise the cause as it came. The runtime reports our abort as a bare
   * AbortError, which a caller would otherwise mistake for a stop the person
   * asked for.
   */
  failure(cause: unknown): unknown
  /** Stops the clock. Called when the request is over, however it ended. */
  release(): void
}

export function watchForStall(options: {
  provider: string
  model: string
  signal: AbortSignal
  timeouts?: Partial<StallTimeouts>
}): StallWatch {
  const limits = { ...DEFAULT_STALL_TIMEOUTS, ...options.timeouts }
  const clock = new AbortController()
  let handle: ReturnType<typeof setTimeout> | undefined
  let stalled: ProviderResponseError | undefined
  let streamed = false
  let unlisten: () => void = () => {}

  // Rejected when the clock runs out. Made once and handled once, so a stall
  // that fires while nobody is waiting on the body — the fetch itself is
  // still pending — is not an unhandled rejection.
  let ranOut: (error: ProviderResponseError) => void = () => {}
  const stall = new Promise<never>((_, reject) => {
    ranOut = reject
  })
  stall.catch(() => {})

  // Rejected when the caller gives up. A fetched body notices that on its
  // own, since the abort tears the socket down; a body that arrived some
  // other way — through a proxy, or a fake — might not, and Esc must not
  // wait on the idle limit. The listener is taken off again on release: the
  // caller's signal can live as long as the session, and one listener per
  // request on it would be a leak that grows with every turn.
  const stopped = new Promise<never>((_, reject) => {
    const abandoned = (): void =>
      reject(options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    if (options.signal.aborted) abandoned()
    else options.signal.addEventListener('abort', abandoned, { once: true })
    unlisten = () => options.signal.removeEventListener('abort', abandoned)
  })
  stopped.catch(() => {})

  const arm = (ms: number): void => {
    clearTimeout(handle)
    handle = setTimeout(() => {
      stalled = stallError(options.provider, options.model, ms, streamed)
      ranOut(stalled)
      clock.abort(stalled)
    }, ms)
  }
  const release = (): void => {
    clearTimeout(handle)
    handle = undefined
    unlisten()
  }

  arm(limits.firstByteMs)

  return {
    signal: AbortSignal.any([options.signal, clock.signal]),
    release,
    failure: (cause) => stalled ?? cause,

    async *body(stream) {
      const chunks = stream[Symbol.asyncIterator]()
      try {
        for (;;) {
          // The first-byte clock is still running on the first pull; every
          // later one runs on the idle clock. The clock only runs while a
          // chunk is awaited, so a slow consumer is never mistaken for a
          // quiet service.
          if (streamed) arm(limits.idleMs)
          const pending = chunks.next()
          // Handled here as well as in the race: when the clock wins, this
          // settles later with nobody waiting on it, and a rejection nobody
          // handles is reported as a crash.
          pending.catch(() => {})
          const step = await Promise.race([pending, stall, stopped])
          clearTimeout(handle)
          if (step.done) return
          streamed = true
          yield step.value
        }
      } catch (cause) {
        release()
        if (stalled) {
          // The socket is being closed by the abort; the iterator is told
          // too, without waiting, since a stream that stalled may never
          // acknowledge it.
          void chunks.return?.().catch(() => {})
          throw stalled
        }
        throw cause
      }
    },
  }
}

function stallError(
  provider: string,
  model: string,
  waitedMs: number,
  streamed: boolean,
): ProviderResponseError {
  const waited = waitedMs < 1000 ? `${waitedMs}ms` : `${Math.round(waitedMs / 1000)}s`
  return streamed
    ? // Not sent again: the caller already has part of an answer, and a second
      // attempt would give the turn two beginnings.
      new ProviderResponseError(
        `${provider}: ${model} went quiet for ${waited} in the middle of its answer`,
        provider,
        false,
      )
    : new ProviderResponseError(
        `${provider}: ${model} did not start answering within ${waited}`,
        provider,
        true,
      )
}
