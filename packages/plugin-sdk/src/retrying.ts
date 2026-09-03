import type { Provider, StreamDelta } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import { RetryAfterError } from './rate-limit.ts'

/**
 * How long a service is left alone at most, whatever it asked for.
 *
 * A `Retry-After` of an hour is a real answer some services give when a
 * daily quota is spent. Honoured literally it holds a turn open for an hour
 * with a spinner on the screen; capped, the turn fails in a minute with the
 * service's own sentence, which is something a person can act on.
 */
const LONGEST_WAIT_MS = 60_000

/**
 * A provider that sends the request again when the service says it may be.
 *
 * `ProviderResponseError` has carried `retryable` — "whether the same request
 * could succeed if sent again" — since it was written, and every provider that
 * computes it computes it correctly. Nothing has ever read it. So a gateway
 * answering "endpoint is unavailable" for two seconds ended an agent's turn
 * for good, and the work it was in the middle of was lost.
 *
 * Only before anything has been streamed. Once deltas have gone out the
 * caller has half an answer, and sending the request again would produce a
 * turn with two beginnings — so a failure there is reported as it always was.
 * In practice this is the case that matters: a service that is down says so
 * on the first byte.
 *
 * Waits longer each time, because a service that is unavailable now is likely
 * still unavailable in a hundred milliseconds, and asking again immediately is
 * how a queue that is already struggling gets a second copy of everything.
 * Unless the service said how long: a rate limit that names its window is
 * waited out for exactly that, since guessing shorter only buys another
 * refusal and guessing longer wastes the difference.
 */
export function retrying(
  provider: Provider,
  attempts = 3,
  waitMs = 400,
  longestWaitMs = LONGEST_WAIT_MS,
): Provider {
  return {
    id: provider.id,
    async *send(request, signal): AsyncIterable<StreamDelta> {
      for (let attempt = 1; ; attempt++) {
        let started = false
        try {
          for await (const delta of provider.send(request, signal)) {
            started ||= isAnswer(delta)
            yield delta
          }
          return
        } catch (cause) {
          if (attempt >= attempts || !worthAnotherTry(cause, started, signal)) throw cause
          await backOff(waitFor(cause, waitMs * attempt, longestWaitMs), signal, cause)
        }
      }
    },
  }
}

/**
 * Whether a delta is part of the answer.
 *
 * A meter is news about the allowance, not part of the answer: a turn that
 * has only said how much is left can still be sent again without giving the
 * caller two beginnings. Counted as output, a provider that reports its
 * rate-limit headers before the first token would turn every first-byte
 * failure into one that cannot be retried.
 */
function isAnswer(delta: StreamDelta): boolean {
  return delta.type !== 'meter'
}

/**
 * Whether sending again could help: the service said so, nothing has gone out
 * yet, and the turn is still wanted.
 */
function worthAnotherTry(cause: unknown, started: boolean, signal: AbortSignal): boolean {
  return cause instanceof ProviderResponseError && cause.retryable && !started && !signal.aborted
}

/** The service's own figure when it gave one, capped; otherwise ours. */
function waitFor(cause: unknown, ownGuessMs: number, longestWaitMs: number): number {
  const asked = cause instanceof RetryAfterError ? cause.retryAfterMs : 0
  return asked > 0 ? Math.min(asked, longestWaitMs) : ownGuessMs
}

/**
 * Waits before the next attempt, unless the turn is abandoned first.
 *
 * A plain timer slept through the abort. Esc, a kill, a shutdown — every one
 * of them was noticed only once the whole delay had elapsed, and by the third
 * attempt that is over a second spent on a turn that was already over. Woken
 * by the abort instead, this throws the error it was waiting to retry, which
 * is what the caller would have been given had the abort come a moment
 * earlier.
 */
function backOff(ms: number, signal: AbortSignal, cause: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const abandoned = (): void => {
      clearTimeout(timer)
      reject(cause)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abandoned)
      resolve()
    }, ms)
    signal.addEventListener('abort', abandoned, { once: true })
  })
}
