import { describe, expect, test } from 'bun:test'
import type { CanonicalRequest, Provider, StreamDelta } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import { RetryAfterError } from './rate-limit.ts'
import { retrying } from './retrying.ts'

const usage = { inputTokens: 1, outputTokens: 1 }
const request = {
  model: 'm',
  system: '',
  messages: [],
  tools: [],
  maxTokens: 10,
} as CanonicalRequest

/** A provider that fails a given number of times, then answers. */
function flaky(failures: number, retryable = true, afterSomeOutput = false): Provider {
  let seen = 0
  return {
    id: 'flaky',
    async *send(): AsyncIterable<StreamDelta> {
      seen += 1
      if (seen <= failures) {
        if (afterSomeOutput) yield { type: 'text_delta', text: 'half an answer' }
        throw new ProviderResponseError('endpoint is unavailable', 'flaky', retryable)
      }
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done', stopReason: 'end_turn', usage }
    },
  }
}

async function drain(
  provider: Provider,
  signal = new AbortController().signal,
): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const delta of provider.send(request, signal)) out.push(delta)
  return out
}

describe('a service that is briefly unavailable', () => {
  test('is asked again, because it said the request could succeed', async () => {
    // A gateway answering "endpoint is unavailable" for two seconds ended an
    // agent's turn for good and lost the work it was in the middle of. The
    // error has carried `retryable` since it was written and nothing read it.
    const out = await drain(retrying(flaky(2), 3, 1))

    expect(out.at(-1)?.type).toBe('done')
  })

  test('gives up rather than asking forever', async () => {
    expect(drain(retrying(flaky(9), 3, 1))).rejects.toThrow(/unavailable/)
  })

  test('does not ask again when the service says it would not help', async () => {
    // A bad key answers the same way every time, and asking again is three
    // times the wait for the same message.
    let tries = 0
    const refuses: Provider = {
      id: 'refuses',
      // eslint-disable-next-line require-yield -- it never gets that far
      async *send(): AsyncIterable<StreamDelta> {
        tries += 1
        if (tries > 0) throw new ProviderResponseError('invalid api key', 'refuses', false)
        yield { type: 'done', stopReason: 'end_turn', usage }
      },
    }

    await drain(retrying(refuses, 3, 1)).catch(() => {})
    expect(tries).toBe(1)
  })

  test('does not ask again once part of the answer has gone out', async () => {
    // The caller already has half a turn. Sending the request again would
    // give it a second beginning, which is worse than the failure.
    expect(drain(retrying(flaky(1, true, true), 3, 1))).rejects.toThrow(/unavailable/)
  })

  test('still asks again when all that had gone out was a meter', async () => {
    // A meter is news about the allowance, not part of the answer. A provider
    // that reports its rate-limit headers before the first token had turned
    // every first-byte failure into one that could not be retried.
    let seen = 0
    const metered: Provider = {
      id: 'metered',
      async *send(): AsyncIterable<StreamDelta> {
        seen += 1
        yield { type: 'meter', providerId: 'metered', windows: [] }
        if (seen === 1) throw new ProviderResponseError('overloaded', 'metered', true)
        yield { type: 'done', stopReason: 'end_turn', usage }
      },
    }

    const out = await drain(retrying(metered, 3, 1))

    expect(out.at(-1)?.type).toBe('done')
  })

  test('stops waiting the moment the turn is abandoned, not when the timer runs out', async () => {
    // The back-off slept through an abort. Esc, a kill, a shutdown — every
    // one of them was noticed only after the whole delay had elapsed, and by
    // the third attempt that is over a second spent by a turn that was
    // already over.
    const controller = new AbortController()
    const started = Date.now()
    const turn = drain(retrying(flaky(9), 3, 2000), controller.signal)
    setTimeout(() => controller.abort(), 10)

    await expect(turn).rejects.toThrow(/unavailable/)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('a service that says when to come back', () => {
  /** Fails once with the wait it asks for, then answers. */
  function busy(retryAfterMs: number): Provider {
    let seen = 0
    return {
      id: 'busy',
      async *send(): AsyncIterable<StreamDelta> {
        seen += 1
        if (seen === 1) throw new RetryAfterError('rate limited', 'busy', retryAfterMs)
        yield { type: 'done', stopReason: 'end_turn', usage }
      },
    }
  }

  test('is left alone for as long as it asked, not for a guess', async () => {
    // The back-off was a fixed few hundred milliseconds. A service that says
    // "try again in two seconds" was asked again in four hundred, refused
    // again, and the third attempt landed inside the same window: three
    // refusals in a row for one rate limit, and the turn ended.
    const started = Date.now()

    await drain(retrying(busy(200), 3, 1))

    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
  })

  test('but never longer than the cap, since an hour is a turn that has ended anyway', async () => {
    const started = Date.now()

    await drain(retrying(busy(3_600_000), 3, 1, 30))

    expect(Date.now() - started).toBeLessThan(500)
  })
})
