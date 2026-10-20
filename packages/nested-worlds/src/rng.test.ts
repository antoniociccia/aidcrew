import { describe, expect, it } from 'bun:test'
import { next, nextInt, seedState } from './rng.ts'

describe('rng', () => {
  it('should_return_the_same_sequence_for_the_same_state', () => {
    const a = next(seedState(7))
    const b = next(seedState(7))
    expect(a).toEqual(b)
    expect(next(a.state)).toEqual(next(b.state))
  })

  it('should_return_values_in_unit_interval_and_a_new_uint32_state', () => {
    let s = seedState(1)
    for (let i = 0; i < 1000; i++) {
      const r = next(s)
      expect(r.value).toBeGreaterThanOrEqual(0)
      expect(r.value).toBeLessThan(1)
      expect(Number.isInteger(r.state)).toBe(true)
      expect(r.state).toBeGreaterThanOrEqual(0)
      expect(r.state).toBeLessThan(2 ** 32)
      s = r.state
    }
  })

  it('should_draw_integers_within_inclusive_bounds', () => {
    let s = seedState(42)
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const r = nextInt(s, 3, 9)
      expect(r.value).toBeGreaterThanOrEqual(3)
      expect(r.value).toBeLessThanOrEqual(9)
      seen.add(r.value)
      s = r.state
    }
    expect(seen.size).toBe(7)
  })
})
