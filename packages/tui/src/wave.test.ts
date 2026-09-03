import { describe, expect, test } from 'bun:test'
import { push, wave } from './wave.ts'

describe('wave', () => {
  test('draws one cell per sample', () => {
    expect(wave([1, 2, 3], 3)).toHaveLength(3)
  })

  test('scales to the tallest sample, so a quiet agent is not flat', () => {
    const drawn = wave([0, 1, 2], 3)

    expect(drawn[0]).toBe('▁')
    expect(drawn[2]).toBe('█')
  })

  test('pads on the left, keeping the present at the right edge', () => {
    // A short history should not stretch to fill room it has not earned.
    expect(wave([5], 4)).toBe('▁▁▁█')
  })

  test('keeps only what fits, dropping the oldest', () => {
    expect(wave([9, 9, 9, 1], 2)).toHaveLength(2)
  })

  test('draws a flat line for an agent that has done nothing', () => {
    expect(wave([0, 0, 0], 3)).toBe('▁▁▁')
  })

  test('draws nothing at all for no history', () => {
    expect(wave([], 5)).toBe('▁▁▁▁▁')
  })

  test('returns nothing for no width', () => {
    expect(wave([1, 2], 0)).toBe('')
  })
})

describe('push', () => {
  test('adds the newest sample', () => {
    expect(push([1, 2], 3, 5)).toEqual([1, 2, 3])
  })

  test('drops the oldest once full, so the line scrolls', () => {
    expect(push([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })
})
