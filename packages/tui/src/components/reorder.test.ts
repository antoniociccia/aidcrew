import { describe, expect, test } from 'bun:test'
import { moveTo, tabAt } from './reorder.ts'

describe('moving an agent to where another one is', () => {
  const team = ['architect', 'coder', 'reviewer', 'tester']

  test('takes it out and puts it back, rather than swapping', () => {
    // Swapping is the easy thing and the wrong one: dragging the first tab
    // onto the third should leave the second where the eye expects it, not
    // throw it to the front.
    expect(moveTo(team, 'architect', 2)).toEqual(['coder', 'reviewer', 'architect', 'tester'])
  })

  test('moves one back the same way', () => {
    expect(moveTo(team, 'tester', 0)).toEqual(['tester', 'architect', 'coder', 'reviewer'])
  })

  test('is the same list when it has not moved', () => {
    // Identity, not just equality: a drag inside one tab fires on every
    // reported motion, and rebuilding the array each time would rerender the
    // whole screen for nothing.
    expect(moveTo(team, 'coder', 1)).toBe(team)
  })

  test('does not fall off either end', () => {
    expect(moveTo(team, 'coder', -5)).toEqual(['coder', 'architect', 'reviewer', 'tester'])
    expect(moveTo(team, 'coder', 99)).toEqual(['architect', 'reviewer', 'tester', 'coder'])
  })

  test('leaves a list alone that does not hold it', () => {
    expect(moveTo(team, 'nobody', 0)).toBe(team)
  })
})

describe('which tab a column is in', () => {
  test('divides the width evenly', () => {
    expect(tabAt(0, 100, 4)).toBe(0)
    expect(tabAt(26, 100, 4)).toBe(1)
    expect(tabAt(51, 100, 4)).toBe(2)
  })

  test('gives the last column to the last tab, not to one past the end', () => {
    // The division leaves a remainder, and the tabs are drawn to the edge.
    expect(tabAt(99, 100, 3)).toBe(2)
  })

  test('has no answer when there are no tabs', () => {
    expect(tabAt(10, 100, 0)).toBeUndefined()
  })
})
