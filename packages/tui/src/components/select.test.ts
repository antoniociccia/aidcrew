import { describe, expect, test } from 'bun:test'
import { windowAround } from './select-window.ts'

describe('windowAround', () => {
  test('shows everything when it all fits', () => {
    expect(windowAround(0, 3, 10)).toEqual({ start: 0, end: 3 })
  })

  test('keeps the cursor visible near the top', () => {
    const { start, end } = windowAround(1, 60, 10)

    expect(start).toBe(0)
    expect(end - start).toBe(10)
  })

  test('scrolls once the cursor passes the bottom of the window', () => {
    // The failure this fixes: 63 models, the first ten shown, and the eleventh
    // unreachable no matter how far down you press.
    const { start, end } = windowAround(40, 63, 10)

    expect(start).toBeLessThanOrEqual(40)
    expect(end).toBeGreaterThan(40)
  })

  test('stops at the end rather than scrolling past it', () => {
    const { start, end } = windowAround(62, 63, 10)

    expect(end).toBe(63)
    expect(start).toBe(53)
  })

  test('centres the cursor in the middle of a long list', () => {
    const { start, end } = windowAround(30, 63, 11)

    expect(30 - start).toBeGreaterThan(2)
    expect(end - 30).toBeGreaterThan(2)
  })

  test('handles a list shorter than the window without going negative', () => {
    expect(windowAround(0, 2, 10)).toEqual({ start: 0, end: 2 })
  })

  test('handles an empty list', () => {
    expect(windowAround(0, 0, 10)).toEqual({ start: 0, end: 0 })
  })
})
