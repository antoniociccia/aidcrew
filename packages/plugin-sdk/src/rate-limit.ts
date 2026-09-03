import type { MeterWindow } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'

/**
 * A refusal that says when to come back.
 *
 * The retry wrapper waited a fixed few hundred milliseconds, escalating a
 * little each time. A service that answers 429 with `Retry-After: 2` was
 * asked again in four hundred milliseconds, refused again, and the third
 * attempt landed inside the same window — three refusals for one rate limit,
 * and the turn ended, when the service had said in as many words how long to
 * wait. The number is carried here, on the error every caller already knows,
 * so the wrapper can read it without learning any dialect's headers.
 */
export class RetryAfterError extends ProviderResponseError {
  constructor(
    message: string,
    provider: string,
    /** How long the service asked to be left alone, in milliseconds. */
    readonly retryAfterMs: number,
  ) {
    super(message, provider, true)
  }
}

/**
 * How long a service asked to be left alone, from its headers.
 *
 * `Retry-After` is seconds or an HTTP date, and both are seen in the wild;
 * `retry-after-ms` is a finer figure some gateways send beside it, and wins
 * when present. Undefined when there is no usable figure, which is most
 * refusals — the caller then falls back to a wait of its own.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const fine = Number(headers.get('retry-after-ms'))
  if (headers.get('retry-after-ms') !== null && Number.isFinite(fine) && fine >= 0) return fine

  const coarse = headers.get('retry-after')
  if (coarse === null) return undefined

  const seconds = Number(coarse)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000

  const at = Date.parse(coarse)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/**
 * One window of an allowance, from the limit, what is left of it and when it
 * refills — the triple most services put in their response headers.
 *
 * Nothing is made up: a window missing any of the three has no fraction, and
 * a fraction of nothing on the screen is worse than no window at all. The
 * fraction is clamped, because a service reporting more remaining than its
 * limit should cost us an odd number rather than a negative bar.
 */
export function meterWindow(
  name: string,
  window: { limit: number | undefined; remaining: number | undefined; resetsAt: Date | undefined },
): MeterWindow | undefined {
  const { limit, remaining, resetsAt } = window
  if (limit === undefined || remaining === undefined || resetsAt === undefined) return undefined
  if (!(limit > 0) || Number.isNaN(remaining) || Number.isNaN(resetsAt.getTime())) return undefined

  // The difference over the limit rather than one minus the ratio: the two
  // are equal on paper and not in floating point, where 1 - 99/100 prints
  // as 0.010000000000000009 and finds its way onto the screen.
  return {
    name,
    usedFraction: Math.min(1, Math.max(0, (limit - remaining) / limit)),
    resetsAt,
  }
}
