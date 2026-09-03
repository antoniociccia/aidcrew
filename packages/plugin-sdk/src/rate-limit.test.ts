import { describe, expect, test } from 'bun:test'
import { ProviderResponseError } from '@aidcrew/core'
import { meterWindow, RetryAfterError, retryAfterMs } from './rate-limit.ts'

const now = Date.UTC(2026, 8, 2, 12, 0, 0)

describe('how long a service asked to be left alone', () => {
  test('is read from retry-after in seconds, which is how most services say it', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }), now)).toBe(2000)
    expect(retryAfterMs(new Headers({ 'retry-after': '1.5' }), now)).toBe(1500)
  })

  test('is read from retry-after as a date, which the standard also allows', () => {
    const at = new Date(now + 5000).toUTCString()

    expect(retryAfterMs(new Headers({ 'retry-after': at }), now)).toBe(5000)
  })

  test('is never negative when the date has already passed', () => {
    const at = new Date(now - 5000).toUTCString()

    expect(retryAfterMs(new Headers({ 'retry-after': at }), now)).toBe(0)
  })

  test('prefers retry-after-ms, which is finer and is what some gateways send', () => {
    const headers = new Headers({ 'retry-after': '2', 'retry-after-ms': '250' })

    expect(retryAfterMs(headers, now)).toBe(250)
  })

  test('is unknown when the header is missing or says nothing usable', () => {
    expect(retryAfterMs(new Headers(), now)).toBeUndefined()
    expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }), now)).toBeUndefined()
  })

  test('travels on the error, which is still the error every caller knows', () => {
    const error = new RetryAfterError('slow down', 'zen', 2000)

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect(error.retryable).toBe(true)
    expect(error.retryAfterMs).toBe(2000)
  })
})

describe('one window of an allowance, from the headers most services send', () => {
  const resetsAt = new Date(now + 60_000)

  test('says how much of it is gone, as a fraction', () => {
    expect(meterWindow('tokens', { limit: 100, remaining: 25, resetsAt })).toEqual({
      name: 'tokens',
      usedFraction: 0.75,
      resetsAt,
    })
  })

  test('is never below empty or above full, whatever the numbers say', () => {
    expect(meterWindow('tokens', { limit: 100, remaining: 250, resetsAt })?.usedFraction).toBe(0)
    expect(meterWindow('tokens', { limit: 100, remaining: -5, resetsAt })?.usedFraction).toBe(1)
  })

  test('is not made up when a number is missing', () => {
    // A window with no limit has no fraction, and a fraction of nothing on
    // the screen is worse than no window at all.
    expect(meterWindow('tokens', { limit: undefined, remaining: 25, resetsAt })).toBeUndefined()
    expect(meterWindow('tokens', { limit: 0, remaining: 0, resetsAt })).toBeUndefined()
    expect(
      meterWindow('tokens', { limit: 100, remaining: 25, resetsAt: undefined }),
    ).toBeUndefined()
  })
})
