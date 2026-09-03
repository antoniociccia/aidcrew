import { describe, expect, test } from 'bun:test'
import { meterFromHeaders } from './headers.ts'

const now = Date.UTC(2026, 8, 2, 12, 0, 0)

describe('reading the allowance out of the response headers', () => {
  test('makes one window per family the service reports on', () => {
    const windows = meterFromHeaders(
      new Headers({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '99',
        'x-ratelimit-reset-requests': '1s',
        'x-ratelimit-limit-tokens': '1000',
        'x-ratelimit-remaining-tokens': '250',
        'x-ratelimit-reset-tokens': '6m0s',
      }),
      now,
    )

    expect(windows).toEqual([
      { name: 'requests', usedFraction: 0.01, resetsAt: new Date(now + 1000) },
      { name: 'tokens', usedFraction: 0.75, resetsAt: new Date(now + 360_000) },
    ])
  })

  test('reads the durations the way this service writes them', () => {
    // "6m0s", "1s", "20ms", "1h2m3.5s": the Go duration format, which is not
    // seconds and not a date. A bare number is taken as seconds.
    const reset = (value: string) =>
      meterFromHeaders(
        new Headers({
          'x-ratelimit-limit-tokens': '1',
          'x-ratelimit-remaining-tokens': '1',
          'x-ratelimit-reset-tokens': value,
        }),
        now,
      )[0]?.resetsAt.getTime()

    expect(reset('20ms')).toBe(now + 20)
    expect(reset('1h2m3.5s')).toBe(now + 3_723_500)
    expect(reset('12')).toBe(now + 12_000)
  })

  test('says nothing when the headers are absent or only half there', () => {
    expect(meterFromHeaders(new Headers(), now)).toEqual([])
    expect(meterFromHeaders(new Headers({ 'x-ratelimit-remaining-tokens': '250' }), now)).toEqual(
      [],
    )
    expect(
      meterFromHeaders(
        new Headers({
          'x-ratelimit-limit-tokens': '1000',
          'x-ratelimit-remaining-tokens': '250',
          'x-ratelimit-reset-tokens': 'whenever',
        }),
        now,
      ),
    ).toEqual([])
  })
})
